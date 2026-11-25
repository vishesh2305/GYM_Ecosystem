# Valkey for queues, cache and rate limits; S3 for files, with CloudFront serving only the public part.

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

# BullMQ needs keys never to be evicted (an evicted job is a lost job). Cluster mode stays off, because
# BullMQ's multi-key scripts need every queue key on one shard.
resource "aws_elasticache_parameter_group" "valkey" {
  name   = "${var.name}-valkey"
  family = "valkey8"
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

resource "random_password" "cache" {
  length  = 48
  special = false
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = var.name
  description                = "Queues, cache and rate limits for ${var.name}"
  engine                     = "valkey"
  engine_version             = "8.1"
  node_type                  = var.cache_node_type
  num_cache_clusters         = 1 + var.cache_replicas
  automatic_failover_enabled = var.cache_replicas > 0
  multi_az_enabled           = var.cache_replicas > 0
  parameter_group_name       = aws_elasticache_parameter_group.valkey.name
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.cache.id]
  port                       = 6379
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.cache.result
  snapshot_retention_limit   = 3
  snapshot_window            = "20:00-21:00" # 01:30 to 02:30 in India
  apply_immediately          = false
}

# Terraform writes this secret (it creates the password); the app secret is written by people.
#trivy:ignore:AVD-AWS-0098 The AWS-managed key is used.
resource "aws_secretsmanager_secret" "redis" {
  name                    = "${var.name}/redis"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    REDIS_URL = "rediss://:${random_password.cache.result}@${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
  })
}

# --- Files: private by default (exports, invoices); objects under public/ are served by CloudFront.

resource "aws_s3_bucket" "files" {
  bucket_prefix = "${var.name}-files-"
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

#trivy:ignore:AVD-AWS-0132 SSE-S3 (AES-256) instead of a customer KMS key.
resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "files" {
  bucket = aws_s3_bucket.files.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    id     = "tidy"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
    # Erased or replaced files must not linger as old versions (DPDP erasure).
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_cloudfront_origin_access_control" "files" {
  name                              = "${var.name}-files"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

#trivy:ignore:AVD-AWS-0010 Access logs are not needed for public images.
#trivy:ignore:AVD-AWS-0011 Static public files; the firewall protects the API.
#trivy:ignore:AVD-AWS-0013 The default cloudfront.net certificate is used until a custom domain is added.
resource "aws_cloudfront_distribution" "files" {
  enabled         = true
  comment         = "${var.name} public files"
  is_ipv6_enabled = true
  price_class     = "PriceClass_200" # includes India
  origin {
    origin_id                = "files"
    domain_name              = aws_s3_bucket.files.bucket_regional_domain_name
    origin_path              = "/public"
    origin_access_control_id = aws_cloudfront_origin_access_control.files.id
  }
  default_cache_behavior {
    target_origin_id       = "files"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # AWS managed CachingOptimized
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_s3_bucket_policy" "files" {
  bucket = aws_s3_bucket.files.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudFrontReadsPublicOnly"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.files.arn}/public/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.files.arn } }
      },
      {
        Sid       = "TlsOnly"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.files.arn, "${aws_s3_bucket.files.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.files]
}
