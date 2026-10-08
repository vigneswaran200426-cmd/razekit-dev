variable "region" {
  description = "AWS region for the DEV build runtime."
  type        = string
  default     = "us-east-2"
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "razekit-dev"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "availability_zones" {
  description = "How many AZs get a private subnet (and interface endpoints). Each endpoint costs per AZ-hour; 1 is the cheapest."
  type        = number
  default     = 1
}

variable "runner_image" {
  description = "The runner image, by digest (…/razekit-dev-runner@sha256:…). Build it from runner.Dockerfile and push it to the ECR repository this creates."
  type        = string
}

variable "task_cpu" {
  type    = number
  default = 1024
}

variable "task_memory" {
  type    = number
  default = 2048
}

variable "worker_role_name" {
  description = "Optional: an existing IAM role the DEV worker runs as, to attach the worker policy to. Leave empty to attach it yourself."
  type        = string
  default     = ""
}
