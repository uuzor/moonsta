#!/bin/bash
# Vultr user-data for Moonsta (Ubuntu 24.04). Base64-encode and pass as user_data.
# Installs Docker; code + .env are shipped over SSH afterwards (repo is private).
# NOTE: Ubuntu 24.04 has no docker-compose-plugin apt package — use get.docker.com.
# The stock Vultr image already ships an active /swapfile; nothing to do there.
set -eux
export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
docker compose version
mkdir -p /opt/sentinel
