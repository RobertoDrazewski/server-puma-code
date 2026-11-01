#!/usr/bin/env bash
# Ejecutar EN EL SERVIDOR (VPS) como usuario con sudo. Crea el usuario sin privilegios "estacion"
# y autoriza la clave pública que genera la Estación para su terminal web.
# Uso: sudo bash crear-usuario-estacion.sh "ssh-ed25519 AAAA... estacion"
set -euo pipefail
KEY="${1:-}"
[ -n "$KEY" ] || { echo "Falta la clave pública (copiala desde la Estación: /api/terminal/pubkey)"; exit 1; }
id estacion >/dev/null 2>&1 || adduser --disabled-password --gecos "Estacion Puma" estacion
install -d -m 700 -o estacion -g estacion /home/estacion/.ssh
echo "$KEY" > /home/estacion/.ssh/authorized_keys
chown estacion:estacion /home/estacion/.ssh/authorized_keys; chmod 600 /home/estacion/.ssh/authorized_keys
echo "Listo. Falta permitir SSH desde Docker: agregá a /etc/ssh/sshd_config
  Match User estacion Address 172.16.0.0/12
      PasswordAuthentication no
y luego: sudo systemctl reload ssh"
