# Infrastructure alarms by email. Service-level alerts (error budget, latency, queues, synthetic checks) are
# in Grafana (modules/observability); these catch what only AWS can see.

#trivy:ignore:AVD-AWS-0095 Alarm notifications hold no sensitive data.
resource "aws_sns_topic" "alarms" {
  name = "${var.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  lb_dimensions = { LoadBalancer = aws_lb.this.arn_suffix }
  alarms = {
    api-5xx = {
      description = "The API answered with server errors (more than 10 in 5 minutes)."
      namespace   = "AWS/ApplicationELB"
      metric      = "HTTPCode_Target_5XX_Count"
      statistic   = "Sum"
      period      = 300
      periods     = 1
      threshold   = 10
      dimensions  = local.lb_dimensions
    }
    api-slow = {
      description = "Typical API responses take over 1 second (average, 3 minutes in a row)."
      namespace   = "AWS/ApplicationELB"
      metric      = "TargetResponseTime"
      statistic   = "Average"
      period      = 60
      periods     = 3
      threshold   = 1
      dimensions  = local.lb_dimensions
    }
    api-no-healthy-tasks = {
      description = "The load balancer has no healthy API task: the API is down."
      namespace   = "AWS/ApplicationELB"
      metric      = "HealthyHostCount"
      statistic   = "Minimum"
      period      = 60
      periods     = 2
      threshold   = 1
      comparison  = "LessThanThreshold"
      dimensions  = merge(local.lb_dimensions, { TargetGroup = aws_lb_target_group.api["blue"].arn_suffix })
    }
    api-cpu = {
      description = "API tasks above 85% CPU for 10 minutes (autoscaling at its limit?)."
      namespace   = "AWS/ECS"
      metric      = "CPUUtilization"
      statistic   = "Average"
      period      = 300
      periods     = 2
      threshold   = 85
      dimensions  = { ClusterName = aws_ecs_cluster.this.name, ServiceName = aws_ecs_service.api.name }
    }
    api-memory = {
      description = "API tasks above 85% memory for 10 minutes."
      namespace   = "AWS/ECS"
      metric      = "MemoryUtilization"
      statistic   = "Average"
      period      = 300
      periods     = 2
      threshold   = 85
      dimensions  = { ClusterName = aws_ecs_cluster.this.name, ServiceName = aws_ecs_service.api.name }
    }
    worker-memory = {
      description = "Worker tasks above 85% memory for 10 minutes."
      namespace   = "AWS/ECS"
      metric      = "MemoryUtilization"
      statistic   = "Average"
      period      = 300
      periods     = 2
      threshold   = 85
      dimensions  = { ClusterName = aws_ecs_cluster.this.name, ServiceName = aws_ecs_service.worker.name }
    }
    cache-memory = {
      description = "Valkey memory above 80%: queues will start refusing jobs at 100% (noeviction)."
      namespace   = "AWS/ElastiCache"
      metric      = "DatabaseMemoryUsagePercentage"
      statistic   = "Maximum"
      period      = 300
      periods     = 1
      threshold   = 80
      dimensions  = { ReplicationGroupId = aws_elasticache_replication_group.this.id }
    }
    firewall-blocking = {
      description = "The firewall blocked over 1000 requests in 5 minutes (attack, or a rule hurting users)."
      namespace   = "AWS/WAFV2"
      metric      = "BlockedRequests"
      statistic   = "Sum"
      period      = 300
      periods     = 1
      threshold   = 1000
      dimensions  = { WebACL = aws_wafv2_web_acl.this.name, Region = data.aws_region.current.region, Rule = "ALL" }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = each.value.periods
  threshold           = each.value.threshold
  comparison_operator = lookup(each.value, "comparison", "GreaterThanThreshold")
  dimensions          = each.value.dimensions
  treat_missing_data  = each.key == "api-no-healthy-tasks" ? "breaching" : "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
