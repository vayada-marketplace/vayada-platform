terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "s3" {
    bucket         = "vayada-terraform-state"
    key            = "rehearsal/coordinated/terraform.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "vayada-terraform-lock"
    encrypt        = true
  }
}

provider "aws" {
  region              = "eu-west-1"
  allowed_account_ids = ["269416271598"]
  default_tags {
    tags = { Project = "VAY-2029", Environment = "coordinated-recovery", ManagedBy = "Terraform" }
  }
}

locals {
  prefix   = "vayada-recovery"
  services = toset(["api", "pms", "booking-web", "booking-admin", "marketplace-web", "marketplace-admin"])
  # Official Python multi-platform image, inspected 2026-09-20. Bootstrap only;
  # future fixture releases must use dedicated ECR digests and reviewed provenance.
  image = "docker.io/library/python@sha256:c4634f578a412db396771b61b064c6e546c9d6414c7fb5b1b05d5871f1885f7b"
}

resource "aws_vpc" "fixture" {
  cidr_block           = "10.229.0.0/24"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${local.prefix}-vpc" }
}

resource "aws_subnet" "fixture" {
  vpc_id            = aws_vpc.fixture.id
  cidr_block        = "10.229.0.0/26"
  availability_zone = "eu-west-1a"
  tags              = { Name = "${local.prefix}-subnet" }
}

resource "aws_internet_gateway" "fixture" {
  vpc_id = aws_vpc.fixture.id
  tags   = { Name = "${local.prefix}-internet" }
}

resource "aws_route_table" "fixture" {
  vpc_id = aws_vpc.fixture.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.fixture.id
  }
  tags = { Name = "${local.prefix}-routes" }
}

resource "aws_route_table_association" "fixture" {
  subnet_id      = aws_subnet.fixture.id
  route_table_id = aws_route_table.fixture.id
}

resource "aws_security_group" "fixture" {
  name        = "${local.prefix}-tasks"
  description = "Synthetic fixture probes only; no public ingress"
  vpc_id      = aws_vpc.fixture.id
  ingress {
    description = "Fixture tasks can probe one another"
    protocol    = "tcp"
    from_port   = 8080
    to_port     = 8080
    self        = true
  }
  egress {
    description = "Image registry and CloudWatch HTTPS"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "Fixture probes"
    protocol    = "tcp"
    from_port   = 8080
    to_port     = 8080
    self        = true
  }
}

resource "aws_ecs_cluster" "fixture" {
  name = "vayada-coordinated-recovery"
}

resource "aws_cloudwatch_log_group" "fixture" {
  name              = "/ecs/${local.prefix}"
  retention_in_days = 7
}

resource "aws_ecr_repository" "fixture" {
  for_each             = local.services
  name                 = "${local.prefix}-${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_iam_role" "execution" {
  name = "${local.prefix}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = "269416271598" }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ecs:eu-west-1:269416271598:*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "execution" {
  name = "fixture-images-and-logs"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource = [for repository in aws_ecr_repository.fixture : repository.arn] },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.fixture.arn}:*" }
    ]
  })
}

resource "aws_ecs_task_definition" "fixture" {
  for_each                 = local.services
  family                   = "${local.prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  # Deliberately no task role, secrets, volumes, database or provider credentials.
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([{
    name                   = "${local.prefix}-${each.key}"
    image                  = local.image
    essential              = true
    user                   = "65534:65534"
    readonlyRootFilesystem = true
    command                = ["python", "-u", "-c", file("${path.module}/fixture.py")]
    environment            = [{ name = "FIXTURE_SERVICE", value = each.key }, { name = "FIXTURE_REVISION", value = "bootstrap-v1" }]
    portMappings           = [{ containerPort = 8080, protocol = "tcp" }]
    healthCheck = {
      command     = ["CMD", "python", "-c", "import json,urllib.request; r=json.load(urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=3)); assert r['status']=='ok' and r['revision']=='bootstrap-v1'"]
      interval    = 10
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.fixture.name
        awslogs-region        = "eu-west-1"
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

resource "aws_ecs_service" "fixture" {
  for_each        = local.services
  name            = "${local.prefix}-${each.key}"
  cluster         = aws_ecs_cluster.fixture.id
  task_definition = aws_ecs_task_definition.fixture[each.key].arn
  launch_type     = "FARGATE"
  desired_count   = 1
  network_configuration {
    subnets          = [aws_subnet.fixture.id]
    security_groups  = [aws_security_group.fixture.id]
    assign_public_ip = true
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  wait_for_steady_state = true
  depends_on            = [aws_iam_role_policy.execution, aws_route_table_association.fixture]
  # The later reviewed fixture reconciler owns image changes, just as production does.
  lifecycle {
    ignore_changes = [task_definition]
  }
}

output "fixture" {
  value = {
    account_id     = "269416271598"
    region         = "eu-west-1"
    cluster        = aws_ecs_cluster.fixture.name
    state_prefix   = "/vayada/rehearsal/coordinated-deployments/v1"
    subnet_id      = aws_subnet.fixture.id
    security_group = aws_security_group.fixture.id
    execution_role = aws_iam_role.execution.arn
    services       = { for key, service in aws_ecs_service.fixture : key => service.name }
    repositories   = { for key, repository in aws_ecr_repository.fixture : key => repository.repository_url }
  }
}
