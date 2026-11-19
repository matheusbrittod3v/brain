terraform {
  required_version = ">= 1.6.0"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.33"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.16"
    }
  }
}

variable "environment" {
  description = "Deployment environment name (e.g. staging, production)"
  type        = string
  default     = "production"
}

variable "namespace" {
  description = "Kubernetes namespace for Noema workloads"
  type        = string
  default     = "noema-system"
}

variable "noema_image_tag" {
  description = "Pinned container image tag for Noema API and Worker"
  type        = string
  default     = "0.1.0"
}

variable "api_replicas" {
  description = "Number of API pod replicas"
  type        = number
  default     = 2
}

variable "worker_replicas" {
  description = "Number of Worker pod replicas"
  type        = number
  default     = 2
}

variable "postgres_instance_class" {
  description = "Managed PostgreSQL 16 (pgvector) instance class"
  type        = string
  default     = "db.t4g.medium"
}

variable "postgres_storage_gb" {
  description = "Allocated storage in GB for PostgreSQL"
  type        = number
  default     = 50
}

variable "minio_bucket_name" {
  description = "Object storage bucket for Noema artifacts and snapshots"
  type        = string
  default     = "noema-artifacts"
}

resource "kubernetes_namespace" "noema" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
      "environment"                  = var.environment
    }
  }
}

resource "helm_release" "noema" {
  name       = "noema"
  chart      = "${path.module}/../kubernetes"
  namespace  = kubernetes_namespace.noema.metadata[0].name
  wait       = true
  atomic     = true

  values = [
    yamlencode({
      api = {
        replicaCount = var.api_replicas
        image = {
          tag = var.noema_image_tag
        }
      }
      worker = {
        replicaCount = var.worker_replicas
        image = {
          tag = var.noema_image_tag
        }
      }
      postgres = {
        pgBossEnabled = true
        host          = "noema-postgres.${var.namespace}.svc.cluster.local"
      }
    })
  ]
}

resource "helm_release" "postgresql" {
  name       = "noema-postgres"
  repository = "https://charts.bitnami.com/bitnami"
  chart      = "postgresql"
  version    = "15.5.38"
  namespace  = kubernetes_namespace.noema.metadata[0].name

  set {
    name  = "image.repository"
    value = "pgvector/pgvector"
  }

  set {
    name  = "image.tag"
    value = "pg16"
  }

  set {
    name  = "auth.database"
    value = "noema"
  }

  set {
    name  = "primary.persistence.size"
    value = "${var.postgres_storage_gb}Gi"
  }
}

resource "helm_release" "minio" {
  name       = "noema-minio"
  repository = "https://charts.min.io/"
  chart      = "minio"
  version    = "5.3.0"
  namespace  = kubernetes_namespace.noema.metadata[0].name

  set {
    name  = "mode"
    value = "standalone"
  }

  set {
    name  = "defaultBuckets"
    value = var.minio_bucket_name
  }
}

output "noema_hub_topology" {
  value = "PostgreSQL 16 (pgvector + pg-boss, ${var.postgres_instance_class}) + MinIO (${var.minio_bucket_name}) + apps/api + apps/worker (${var.environment})"
}
