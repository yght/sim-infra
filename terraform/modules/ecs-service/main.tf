/**
 * One Fargate service behind the shared ALB.
 *
 * Used for all four platform services (gateway, sim-service, carrier-service,
 * provisioning-worker). The worker passes create_listener_rule = false, since
 * it takes work off a queue and has nothing to serve.
 */

locals {
  tags = merge(var.tags, {
    Module  = "ecs-service"
    Service = var.service_name
  })
}

resource "aws_cloudwatch_log_group" "service" {
  name              = "/ecs/${var.cluster_name}/${var.service_name}"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

resource "aws_ecs_task_definition" "service" {
  family                   = "${var.cluster_name}-${var.service_name}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name      = var.service_name
      image     = var.image
      essential = true

      portMappings = var.container_port == 0 ? [] : [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        }
      ]

      environment = [
        for key, value in var.environment : {
          name  = key
          value = value
        }
      ]

      # Carrier credentials come from Secrets Manager at task start. They are
      # never in the task definition, which is world-readable to anyone with
      # ecs:DescribeTaskDefinition.
      secrets = [
        for key, arn in var.secrets : {
          name      = key
          valueFrom = arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "ecs"
        }
      }

      healthCheck = var.container_port == 0 ? null : {
        command     = ["CMD-SHELL", "curl -f http://localhost:${var.container_port}/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
  ])

  tags = local.tags
}

resource "aws_security_group" "service" {
  name        = "${var.cluster_name}-${var.service_name}"
  description = "Task security group for ${var.service_name}"
  vpc_id      = var.vpc_id

  egress {
    description = "Carrier APIs, Auth0 and AWS services"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.tags, { Name = "${var.cluster_name}-${var.service_name}" })
}

/**
 * Only the load balancer may reach the task port. A separate rule rather than
 * an inline ingress block so that adding another source later does not
 * destroy and recreate the group.
 */
resource "aws_security_group_rule" "from_alb" {
  count = var.container_port == 0 ? 0 : 1

  type                     = "ingress"
  security_group_id        = aws_security_group.service.id
  source_security_group_id = var.alb_security_group_id
  from_port                = var.container_port
  to_port                  = var.container_port
  protocol                 = "tcp"
  description              = "ALB to task"
}

resource "aws_lb_target_group" "service" {
  count = var.container_port == 0 ? 0 : 1

  name        = substr("${var.cluster_name}-${var.service_name}", 0, 32)
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = var.health_check_path
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 15
    matcher             = "200"
  }

  # Long enough for an in-flight carrier call to finish before the task goes
  # away. Vodafone routinely take eight seconds and killing the connection
  # mid-provision leaves a SIM in an ambiguous state at their end.
  deregistration_delay = 30

  tags = local.tags
}

resource "aws_lb_listener_rule" "service" {
  count = var.create_listener_rule ? 1 : 0

  listener_arn = var.alb_listener_arn
  priority     = var.listener_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service[0].arn
  }

  condition {
    path_pattern {
      values = var.path_patterns
    }
  }

  tags = local.tags
}

resource "aws_ecs_service" "service" {
  name            = var.service_name
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.service.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  # Deploy without dropping below capacity: 100% minimum healthy means the new
  # tasks come up before the old ones go away.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  health_check_grace_period_seconds = var.container_port == 0 ? null : 60

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.container_port == 0 ? [] : [1]

    content {
      target_group_arn = aws_lb_target_group.service[0].arn
      container_name   = var.service_name
      container_port   = var.container_port
    }
  }

  tags = local.tags
}
