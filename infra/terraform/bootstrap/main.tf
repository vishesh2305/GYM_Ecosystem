# Applied once per AWS account, by a person, with local state (keep terraform.tfstate safe, or move it into
# the bucket afterwards). Creates what every environment shares: the Terraform state bucket, the image
# registry, and the role GitHub Actions deploys with (OIDC, so no AWS keys are stored in GitHub).
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.20" }
  }
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "github_repository" {
  description = "owner/name of the repository allowed to deploy."
  type        = string
  default     = "vishesh2305/GYM_Ecosystem"
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "gym-platform", ManagedBy = "terraform" }
  }
}

data "aws_caller_identity" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
}

resource "aws_s3_bucket" "state" {
  bucket = "gym-platform-terraform-state-${local.account}"
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

#trivy:ignore:AVD-AWS-0132 SSE-S3 (AES-256) instead of a customer KMS key.
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

#trivy:ignore:AVD-AWS-0033 The AWS-managed key encrypts images.
resource "aws_ecr_repository" "api" {
  name                 = "gym-api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

#trivy:ignore:AVD-AWS-0033 The AWS-managed key encrypts images.
resource "aws_ecr_repository" "backup" {
  name                 = "gym-backup"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  for_each   = { api = aws_ecr_repository.api.name, backup = aws_ecr_repository.backup.name }
  repository = each.value
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 100 images (rollbacks reach far enough back)"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 100 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

# Only workflow jobs running in the repository's staging or production environment may deploy; production
# jobs wait for a reviewer's approval in GitHub (environment protection rule).
resource "aws_iam_role" "deploy" {
  name = "gym-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = [
            "repo:${var.github_repository}:environment:staging",
            "repo:${var.github_repository}:environment:production",
          ]
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
          "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = [aws_ecr_repository.api.arn, aws_ecr_repository.backup.arn]
      },
      {
        # These ECS actions do not support resource-level permissions.
        Effect   = "Allow"
        Action   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = ["ecs:DescribeServices", "ecs:UpdateService", "ecs:RunTask", "ecs:DescribeTasks"]
        Resource = [
          "arn:aws:ecs:${var.region}:${local.account}:service/gym-*/*",
          "arn:aws:ecs:${var.region}:${local.account}:task/gym-*/*",
          "arn:aws:ecs:${var.region}:${local.account}:task-definition/gym-*:*",
        ]
      },
      {
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          "arn:aws:iam::${local.account}:role/gym-*-execution",
          "arn:aws:iam::${local.account}:role/gym-*-task",
        ]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Effect   = "Allow"
        Action   = ["logs:GetLogEvents"]
        Resource = "arn:aws:logs:${var.region}:${local.account}:log-group:/ecs/gym-*:*"
      },
    ]
  })
}

output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}

output "image_repository" {
  value = aws_ecr_repository.api.repository_url
}

output "backup_image_repository" {
  value = aws_ecr_repository.backup.repository_url
}

output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN variable of the GitHub repository."
  value       = aws_iam_role.deploy.arn
}
