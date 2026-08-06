# Setup PostgreSQL SSH Tunnel Sidecar

Dokumen ini menjelaskan setup manual untuk menghubungkan `sap-integration` ke PostgreSQL melalui service Compose `db-tunnel`. Port PostgreSQL hasil forwarding hanya tersedia di network bridge `sap_backend` dan tidak dipublikasikan ke host.

## Arsitektur koneksi

```text
sap-integration
  DATABASE_URL host: db-tunnel:15432
             |
             v
db-tunnel (SSH local forwarding, internal Compose network only)
  0.0.0.0:15432 -> SSH fariz@38.47.88.75:22 -> 127.0.0.1:5432
```

Container Node.js tidak menjalankan proses SSH. Sidecar keluar jika autentikasi, host verification, atau port forwarding gagal; Compose kemudian mencoba menyambungkannya kembali sesuai `restart: unless-stopped`.

## 1. Buat SSH key khusus integration

Jalankan di host deployment, bukan di container dan bukan di dalam image:

```bash
mkdir -p secrets
chmod 700 secrets
ssh-keygen -t ed25519 -a 100 -f secrets/id_ed25519 -C "sap-procol-db-tunnel"
chmod 600 secrets/id_ed25519
chmod 644 secrets/id_ed25519.pub
```

Gunakan key yang khusus untuk integration service. Jangan menggunakan personal key, jangan memasukkan private key ke image, dan jangan menyimpan SSH password di `.env`.

`secrets/id_ed25519` dan public-key pasangannya sudah diabaikan oleh Git. Dockerfile sidecar tidak menyalin keduanya ke image; Compose memasangnya sebagai runtime secret.

Pada Docker Compose native Linux, secret dengan source file memakai bind mount sehingga ownership/mode host dapat dipertahankan. Sidecar berjalan sebagai UID/GID `10002`. Jika key mode `0600` tidak dapat dibaca sidecar, berikan group-read hanya kepada GID sidecar—jangan membuat key world-readable:

```bash
sudo chgrp 10002 secrets/id_ed25519
chmod 0640 secrets/id_ed25519
```

Pastikan GID `10002` pada host deployment memang dikhususkan untuk service ini. Pada Docker Desktop, langkah group tersebut biasanya tidak diperlukan. Dalam semua kasus, entrypoint menyalin key yang readable ke tmpfs, menerapkan mode `0600`, lalu menjalankan OpenSSH sebagai UID `10002`. Jika source secret tetap tidak readable, container berhenti dengan aman tanpa mencetak key.

## 2. Pasang public key di SSH server

Berikan hanya isi `secrets/id_ed25519.pub` kepada administrator server. Administrator memasangnya pada `~fariz/.ssh/authorized_keys` dengan ownership dan permission yang benar.

Untuk mempersempit hak key, administrator dapat menggunakan pembatasan authorized key berikut sebelum public key:

```text
no-agent-forwarding,no-X11-forwarding,no-pty,permitopen="127.0.0.1:5432"
```

Pastikan konfigurasi `sshd` mengizinkan local TCP forwarding untuk user tersebut. Private key tidak boleh dipindahkan ke SSH server.

## 3. Peroleh dan verifikasi host fingerprint

Minta fingerprint host key ED25519 yang resmi dari administrator melalui kanal tepercaya dan terpisah. Jangan mempercayai hasil `ssh-keyscan` tanpa membandingkannya dengan fingerprint resmi.

Ambil kandidat host key tanpa menampilkan atau membaca credential:

```bash
ssh-keyscan -p 22 -t ed25519 38.47.88.75 > secrets/known_hosts.candidate
ssh-keygen -lf secrets/known_hosts.candidate
```

Bandingkan fingerprint yang tampil dengan fingerprint dari administrator. Jika identik:

```bash
mv secrets/known_hosts.candidate secrets/known_hosts
chmod 644 secrets/known_hosts
```

Jika berbeda, hapus file kandidat dan hentikan setup sampai administrator mengonfirmasi penyebabnya. Jangan memakai `StrictHostKeyChecking=no`.

## 4. Siapkan SAP CA certificate

Tempatkan CA publik internal SAP pada:

```text
secrets/sap-ca.crt
```

CA ini dipasang ke container aplikasi sebagai `/run/secrets/sap-ca.crt`, sesuai `SAP_CA_CERT_PATH`. Kebijakan repository saat ini tidak otomatis mengabaikan CA tersebut; tim harus memutuskan apakah CA publik memang dikelola di repository.

## 5. Isi konfigurasi runtime

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env` secara lokal. Isi password database pada `DATABASE_URL` dan credential SAP tanpa membagikannya melalui chat, log, screenshot, atau commit. Password dalam URL PostgreSQL wajib di-URL-encode bila mengandung karakter khusus.

Di dalam Compose, host database harus tetap:

```text
db-tunnel:15432
```

Jangan menggantinya dengan `localhost`, `127.0.0.1`, alamat SSH server, atau hostname database lama. Variable SSH hanya berisi host, port, user, dan tujuan forwarding; tidak ada variable SSH password.

## 6. Build dan jalankan Compose

```bash
docker compose config --quiet
docker compose build
docker compose up -d
```

`sap-integration` mempunyai dependency `service_healthy`, sehingga aplikasi baru dimulai setelah healthcheck port tunnel berhasil.

## 7. Periksa tunnel tanpa mengekspos credential

```bash
docker compose ps db-tunnel
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q db-tunnel)"
```

Status yang diharapkan adalah `healthy`. Pastikan port tunnel tidak dipublikasikan ke host:

```bash
docker compose port db-tunnel 15432
```

Command terakhir tidak boleh menghasilkan host-port mapping.

Untuk diagnosis autentikasi atau host-key failure, periksa log sidecar. Entrypoint tidak mengaktifkan verbose SSH dan tidak pernah mencetak isi private key:

```bash
docker compose logs --tail=100 db-tunnel
```

## 8. Uji database dari container aplikasi

Command berikut menjalankan `SELECT 1` dan hanya mencetak status, bukan connection string atau credential:

```bash
docker compose exec sap-integration node --input-type=module -e '
import pg from "pg";
const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await client.query("SELECT 1");
  console.log("database connection: ok");
} finally {
  await client.end();
}
'
```

Health endpoint aplikasi juga dapat digunakan setelah schema migration tersedia:

```bash
curl --fail --silent http://127.0.0.1:3000/health/ready
```

Jangan menjalankan command yang mencetak environment container, `.env`, `DATABASE_URL`, private key, atau password.

## 9. Rotasi dan recovery

- Untuk rotasi key, pasang public key baru di server, ganti runtime secret private key, lalu recreate `db-tunnel`.
- Untuk perubahan host key yang sah, verifikasi fingerprint baru melalui administrator sebelum mengganti `known_hosts`.
- Jika SSH atau forwarding gagal, sidecar akan keluar. Restart policy mencoba kembali; aplikasi tidak dimulai sampai tunnel sehat.
- Jangan membuka port `15432` melalui `ports:`. Akses hanya diberikan melalui network `sap_backend`.
