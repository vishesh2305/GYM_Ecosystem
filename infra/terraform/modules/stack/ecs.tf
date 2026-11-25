# ECS Fargate: the API behind the load balancer and the background worker, both from one image. Deploys
# (.github/workflows/deploy.yml) register new task definitions with a new image; Terraform owns the rest.

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

#trivy:ignore:AVD-AWS-0017 AWS-managed encryption; logs hold no secrets (the API redacts them).
resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "worker"])
  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
}

# The app's secrets. Terraform creates the empty secret; people put the values in (never in Terraform state):
# a JSON object with every key in var.secret_keys. See infra/terraform/README.md.
#trivy:ignore:AVD-AWS-0098 The AWS-managed key is used; a customer key adds cost without a gain here.
resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.name}/app"
  recovery_window_in_days = 7
}

locals {
  service_names = { api = "gym-api", worker = "gym-worker" }
  plain_env = merge(
    {
      NODE_ENV                      = "production"
      DEPLOY_ENV                    = var.deploy_env
      HOST                          = "0.0.0.0"
      PORT                          = "3000"
      TRUST_PROXY                   = "true" # client addresses come from the load balancer's X-Forwarded-For
      OTEL_SEMCONV_STABILITY_OPT_IN = "http"
      OTEL_RESOURCE_ATTRIBUTES      = "service.namespace=${var.deploy_env},deployment.environment.name=${var.deploy_env}"
    },
    var.app_env,
  )
  secrets = concat(
    [for key in var.secret_keys : { name = key, valueFrom = "${aws_secretsmanager_secret.app.arn}:${key}::" }],
    [{ name = "REDIS_URL", valueFrom = "${aws_secretsmanager_secret.redis.arn}:REDIS_URL::" }],
  )
  commands = {
    api    = ["node", "--enable-source-maps", "--import", "./dist/instrumentation.mjs", "dist/main.mjs"]
    worker = ["node", "--enable-source-maps", "--import", "./dist/instrumentation.mjs", "dist/worker.mjs"]
  }
  sizes = {
    api    = { cpu = var.api.cpu, memory = var.api.memory }
    worker = { cpu = var.worker.cpu, memory = var.worker.memory }
  }
}

resource "aws_ecs_task_definition" "app" {
  for_each                 = local.sizes
  family                   = "${var.name}-${each.key}"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  volume {
    name = "tmp"
  }
  container_definitions = jsonencode([{
    name                   = each.key
    image                  = var.image
    essential              = true
    command                = local.commands[each.key]
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    portMappings           = each.key == "api" ? [{ containerPort = 3000, protocol = "tcp" }] : []
    environment = [
      for k, v in merge(local.plain_env, { OTEL_SERVICE_NAME = local.service_names[each.key] }) :
      { name = k, value = v }
    ]
    secrets     = local.secrets
    stopTimeout = 30
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app[each.key].name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name                              = "api"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.app["api"].arn
  desired_count                     = var.api.min_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 60
  propagate_tags                    = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  # A deploy whose new tasks never become healthy is rolled back automatically.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Production: blue/green. New tasks start beside the old ones, traffic moves when they are healthy, and the
  # old ones stay ready for bake_minutes so a bad release can be switched back instantly.
  deployment_configuration {
    strategy             = var.api.blue_green ? "BLUE_GREEN" : "ROLLING"
    bake_time_in_minutes = var.api.blue_green ? var.api.bake_minutes : null
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api["blue"].arn
    container_name   = "api"
    container_port   = 3000
    dynamic "advanced_configuration" {
      for_each = var.api.blue_green ? [1] : []
      content {
        alternate_target_group_arn = aws_lb_target_group.api["green"].arn
        production_listener_rule   = aws_lb_listener_rule.api.arn
        role_arn                   = aws_iam_role.ecs_infrastructure.arn
      }
    }
  }

  # Deploys change the task definition, autoscaling the count, blue/green the live target group.
  lifecycle {
    ignore_changes = [task_definition, desired_count, load_balancer]
  }
  depends_on = [aws_lb_listener_rule.api]
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.app["worker"].arn
  desired_count   = var.worker.count
  launch_type     = "FARGATE"
  propagate_tags  = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api.min_count
  max_capacity       = var.api.max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# --- Roles. The execution role starts tasks (pulls the image, reads secrets); the task role is what the app
# itself may do (only its file bucket); the infrastructure role lets ECS move traffic during blue/green.

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = [aws_secretsmanager_secret.app.arn, aws_secretsmanager_secret.redis.arn]
    }]
  })
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "task_files" {
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.files.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.files.arn
      },
    ]
  })
}

resource "aws_iam_role" "ecs_infrastructure" {
  name = "${var.name}-ecs-infrastructure"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_infrastructure" {
  role       = aws_iam_role.ecs_infrastructure.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRolePolicyForLoadBalancers"
}
