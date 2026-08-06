# SAP TLS: Temporary Exception and Improvement Plan

Tanggal pencatatan: 6 Agustus 2026

## Keputusan sementara

Endpoint SAP saat ini diakses melalui IP private `10.30.68.21:9935` melalui VPN. Certificate yang diberikan server bersifat self-signed dan identitasnya menggunakan `*.hutamakarya.com`, bukan alamat IP tersebut. Karena hostname resmi belum tersedia, validasi TLS standar gagal pada pemeriksaan identitas server.

Untuk menyamakan perilaku aplikasi dengan Postman yang memakai **SSL certificate verification OFF**, aplikasi sementara menggunakan:

```env
SAP_TLS_REJECT_UNAUTHORIZED=false
```

Keputusan ini hanya ditujukan sebagai compatibility exception sampai desain final disetujui bersama senior developer. HTTPS tetap digunakan, tetapi aplikasi belum membuktikan identitas server certificate. Basic Auth hanya boleh dipakai dalam jaringan dan lingkungan yang telah disetujui untuk exception ini.

Saat verification OFF, service menulis event warning `sap_tls_verification_disabled`. Warning tidak memuat URL lengkap, username, password, authorization header, atau isi response.

## Persiapan yang tetap dipertahankan

- `secrets/sap-ca.crt` tetap berada di luar image aplikasi dan dipasang sebagai Docker secret.
- Target mount tetap `/run/secrets/sap-ca.crt`.
- `SAP_CA_CERT_PATH=/run/secrets/sap-ca.crt` tetap menjadi konfigurasi production.
- `rejectUnauthorized` tidak di-hard-code; nilainya dikontrol melalui `SAP_TLS_REJECT_UNAUTHORIZED`.
- Default sementara di source dan template adalah `false`, sehingga keputusan exception terlihat dan dapat diuji.

Certificate publik yang diamati pada 6 Agustus 2026 memiliki SHA-256 fingerprint:

```text
B3:DF:E6:E3:35:8B:B9:F9:F7:10:2D:01:CB:17:FE:6A:4A:26:47:3B:2B:F6:56:C9:AD:30:43:04:8E:6D:BB:4C
```

Fingerprint tersebut adalah hasil observasi dan belum dianggap sebagai konfirmasi independen dari pemilik SAP.

## Risiko yang diterima sementara

Dengan certificate verification OFF, koneksi masih terenkripsi terhadap passive network observer, tetapi client akan menerima certificate apa pun dari endpoint yang menjawab. Jika routing, VPN gateway, firewall, destination host, atau service pada port tersebut dialihkan atau dikompromikan, endpoint yang salah dapat menerima Basic Auth dan mengembalikan data palsu untuk diproses aplikasi.

Direct IP dan VPN menurunkan kemungkinan serangan, tetapi tidak menggantikan autentikasi TLS end-to-end. Exception ini tidak boleh dianggap sebagai target production final tanpa risk acceptance dari pihak yang berwenang.

## Target improvement

Pilih salah satu solusi berikut setelah diskusi teknis:

1. **Hostname resmi dan certificate yang valid** — opsi ideal. Gunakan hostname yang tercantum pada SAN certificate dan aktifkan `SAP_TLS_REJECT_UNAUTHORIZED=true`.
2. **Certificate fingerprint pinning** — tetap mengakses IP, tetapi client hanya menerima exact SHA-256 fingerprint yang telah dikonfirmasi melalui kanal independen.
3. **Private CA yang benar** — terbitkan ulang certificate dengan SAN hostname/IP yang sesuai, lalu pertahankan CA sebagai Docker secret dan aktifkan verification.

Jangan mengganti exception ini dengan global `NODE_TLS_REJECT_UNAUTHORIZED=0`, karena variabel global tersebut dapat menonaktifkan verification untuk koneksi TLS lain di seluruh proses Node.js.

## Rancangan fingerprint pinning

Jika opsi pinning dipilih, tambahkan konfigurasi non-secret berikut:

```env
SAP_TLS_CERT_SHA256=replace-with-independently-confirmed-sha256-fingerprint
SAP_TLS_REJECT_UNAUTHORIZED=true
```

Implementasi `src/sap/client.ts` harus membandingkan `certificate.fingerprint256` dengan nilai yang dikonfigurasi sebelum Basic Auth dikirim. Perbandingan harus menolak koneksi ketika fingerprint kosong atau berbeda. Jangan melakukan fallback otomatis ke verification OFF.

Fingerprint awal harus dikonfirmasi oleh SAP Basis, infrastructure, network, atau security melalui kanal lain dari koneksi yang sedang diuji. Saat certificate diperbarui, aplikasi memang akan gagal tertutup sampai fingerprint baru diverifikasi dan konfigurasi diperbarui.

## Checklist aktivasi keamanan final

1. Dapatkan hostname resmi atau fingerprint SHA-256 resmi.
2. Verifikasi certificate/fingerprint melalui kanal independen.
3. Implementasikan dan uji hostname validation atau pinning.
4. Uji mismatch dengan certificate/fingerprint sintetis dan pastikan request gagal sebelum credential dikirim.
5. Set `SAP_TLS_REJECT_UNAUTHORIZED=true`.
6. Build dan jalankan test suite.
7. Jalankan smoke test dari container melalui VPN.
8. Catat prosedur serta PIC rotasi certificate.
9. Hapus exception hanya setelah hasil pengujian dan approval direkam.
