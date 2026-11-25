# Our own daily database backup (on top of Supabase's backups and point-in-time recovery) and a weekly
# restore drill, both as scheduled Fargate tasks from infra/backup. Backups are kept 35 days in Mumbai and
# copied to Hyderabad (aws.replica), so a regional outage loses neither the data nor its residency in India.

resource "aws_s3_bucket" "backups" {
  bucket_prefix = "${var.name}-backups-"
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket" "backups_replica" {
  provider      = aws.replica
  bucket_prefix = "${var.name}-backups-replica-"
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "backups_replica" {
  provider                = aws.replica
  bucket                  = aws_s3_bucket.backups_replica.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

#trivy:ignore:AVD-AWS-0132 SSE-S3 (AES-256) instead of a customer KMS key.
resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

#trivy:ignore:AVD-AWS-0132 SSE-S3 (AES-256) instead of a customer KMS key.
resource "aws_s3_bucket_server_side_encryption_configuration" "backups_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.backups_replica.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "backups_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.backups_replica.id
  versioning_configuration {
    status = "Enabled"
  }
}

# 35 days, then gone (with every old version), in both regions.
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "keep-35-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 35
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups_replica" {
  provider = aws.replica
  bucket   = aws_s3_bucket.backups_replica.id
  rule {
    id     = "keep-35-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 35
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
}

data "aws_iam_policy_document" "tls_only" {
  for_each = { main = aws_s3_bucket.backups.arn, replica = aws_s3_bucket.backups_replica.arn }
  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [each.value, "${each.value}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "backups" {
  bucket     = aws_s3_bucket.backups.id
  policy     = data.aws_iam_policy_document.tls_only["main"].json
  depends_on = [aws_s3_bucket_public_access_block.backups]
}

resource "aws_s3_bucket_policy" "backups_replica" {
  provider   = aws.replica
  bucket     = aws_s3_bucket.backups_replica.id
  policy     = data.aws_iam_policy_document.tls_only["replica"].json
  depends_on = [aws_s3_bucket_public_access_block.backups_replica]
}

resource "aws_iam_role" "backup_replication" {
  name = "${var.name}-backup-replication"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "backup_replication" {
  role = aws_iam_role.backup_replication.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
        Resource = aws_s3_bucket.backups.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"]
        Resource = "${aws_s3_bucket.backups.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"]
        Resource = "${aws_s3_bucket.backups_replica.arn}/*"
      },
    ]
  })
}

resource "aws_s3_bucket_replication_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  role   = aws_iam_role.backup_replication.arn
  rule {
    id     = "to-hyderabad"
    status = "Enabled"
    filter {}
    delete_marker_replication {
      status = "Enabled"
    }
    destination {
      bucket        = aws_s3_bucket.backups_replica.arn
      storage_class = "STANDARD_IA"
    }
  }
  depends_on = [aws_s3_bucket_versioning.backups, aws_s3_bucket_versioning.backups_replica]
}

# --- The tasks.

#trivy:ignore:AVD-AWS-0017 AWS-managed encryption; logs hold counts and timings only.
resource "aws_cloudwatch_log_group" "backup" {
  name              = "/ecs/${var.name}/backup"
  retention_in_days = 90
}

resource "aws_iam_role" "backup_task" {
  name               = "${var.name}-backup-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "backup_task" {
  role = aws_iam_role.backup_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.backups.arn}/daily/*"
      },
      {
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.backups.arn
      },
    ]
  })
}

resource "aws_ecs_task_definition" "backup" {
  family                   = "${var.name}-backup"
  cpu                      = 1024
  memory                   = 2048
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.backup_task.arn
  ephemeral_storage {
    size_in_gib = var.backup_disk_gib # the drill restores a full copy of the database here
  }
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  volume {
    name = "tmp"
  }
  container_definitions = jsonencode([{
    name                   = "backup"
    image                  = var.backup_image
    essential              = true
    command                = ["backup.sh"]
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    environment            = [{ name = "BACKUP_BUCKET", value = aws_s3_bucket.backups.bucket }]
    secrets = [
      { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.app.arn}:DATABASE_URL::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.backup.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "backup"
      }
    }
  }])
}

resource "aws_iam_role" "scheduler" {
  name = "${var.name}-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecs:RunTask"
        Resource = "arn:aws:ecs:${data.aws_region.current.region}:*:task-definition/${aws_ecs_task_definition.backup.family}:*"
      },
      {
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = [aws_iam_role.execution.arn, aws_iam_role.backup_task.arn]
      },
    ]
  })
}

locals {
  backup_jobs = {
    # 02:30 in India.
    backup = { schedule = "cron(0 21 * * ? *)", command = ["backup.sh"] }
    # Sundays 04:30 in India, after that night's backup.
    restore-drill = { schedule = "cron(0 23 ? * SAT *)", command = ["restore-drill.sh"] }
  }
}

resource "aws_scheduler_schedule" "backup" {
  for_each                     = local.backup_jobs
  name                         = "${var.name}-${each.key}"
  schedule_expression          = each.value.schedule
  schedule_expression_timezone = "UTC"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_ecs_cluster.this.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ containerOverrides = [{ name = "backup", command = each.value.command }] })
    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.backup.arn
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = aws_subnet.private[*].id
        security_groups  = [aws_security_group.tasks.id]
        assign_public_ip = false
      }
    }
    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}

# An alarm email when a backup or a drill ends with an error.
resource "aws_cloudwatch_event_rule" "backup_failed" {
  name        = "${var.name}-backup-failed"
  description = "A backup or restore drill task stopped with an error"
  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.this.arn]
      group      = ["family:${aws_ecs_task_definition.backup.family}"]
      lastStatus = ["STOPPED"]
      containers = { exitCode = [{ "anything-but" = 0 }] }
    }
  })
}

resource "aws_cloudwatch_event_target" "backup_failed" {
  rule      = aws_cloudwatch_event_rule.backup_failed.name
  arn       = aws_sns_topic.alarms.arn
  target_id = "email"
}

resource "aws_sns_topic_policy" "alarms" {
  arn = aws_sns_topic.alarms.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudWatchAlarms"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.alarms.arn
      },
      {
        Sid       = "BackupFailures"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.alarms.arn
        Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.backup_failed.arn } }
      },
    ]
  })
}
