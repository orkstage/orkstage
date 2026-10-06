module "network" {
  source = "./modules/network"
}

module "db" {
  source         = "./modules/db"
  name           = "orders-db"
  instance_class = "db.r7g.large"
  multi_az       = true
}

module "api" {
  source   = "./modules/service"
  name     = "orders-api"
  image    = "ghcr.io/acme/orders-api:2.1.0"
  cpu      = 1
  memory   = 2048
  replicas = 3
  port     = 3000
  environment = {
    DATABASE_HOST = module.db.host
  }
}

module "worker" {
  source   = "./modules/service"
  name     = "orders-worker"
  image    = "ghcr.io/acme/orders-worker:2.1.0"
  replicas = 2
  environment = {
    DATABASE_HOST = module.db.host
  }
}
