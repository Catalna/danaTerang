# Naskah Slide Pitch DanaTerang

> Format per slide: **Judul** → isi slide (bullet pendek untuk ditampilkan) → 🎤 *Catatan pembicara* (yang diucapkan).
> Data bersumber dari docs/research/case-studies-data.md — semua angka nyata dan bisa diverifikasi.

---

## Slide 1 — COVER

**DanaTerang**
*Bukti Nyata. Dana yang Terpercaya.*

Platform akuntabilitas berbasis bukti untuk program sosial dan pendanaan —
diverifikasi manusia, diikat kriptografi, terbuka untuk publik.

📊 *Catatan pembicara:* "Halo, kami DanaTerang. Satu kalimatnya: kami membuat setiap rupiah program sosial bisa dibuktikan ke mana perginya — oleh publik, tanpa harus percaya siapa pun."

---

## Slide 2 — PERMASALAHAN: Uang mengalir, bukti tidak ada

- **Rp10.000** dipotong dari **setiap paket** bansos COVID-19 — oleh Menteri Sosial. Suap **Rp32,48 miliar**. Vonis 12 tahun. *(KPK, 2021)*
- Kerugian Bansos Presiden/Beras 2020: **±Rp250 miliar** *(revisi KPK, 2024)*
- Korupsi bansos COVID-19: **6 tersangka**, kerugian **±Rp127,5 miliar**
- Korupsi tingkat desa/pemda: **592 kasus, Rp433,8 miliar** dalam 7 tahun
- Anggaran Kemensos 2025: **Rp78,2 triliun** — dan skornya: IPK Indonesia **37/100**

📊 *Catatan pembicara:* "Bukan kurangnya aturan — UU-nya lengkap. Akar masalahnya: bukti penggunaan dana ada di tangan pihak yang paling berpotensi memanipulasinya, dan publik hanya bisa percaya kata-kata. Bahkan Menteri Sosial bisa memotong 10 ribu dari setiap paket — karena tidak ada bukti yang tidak bisa dia sentuh."

---

## Slide 3 — AKAR MASALAH: Tiga celah yang berulang terjadi

- **Bukti di tangan pihak yang diawasi** — LPJ dan nota bisa direkayasa setelah kejadian
- **Verifikasi tanpa independensi** — pemeriksa bisa "dijatah", tidak ada yang bisa membuktikan siapa memutuskan apa
- **Klaim tanpa pembanding** — "dana tersalurkan" tidak punya sidik jari yang bisa dicek publik

📊 *Catatan pembicara:* "Setiap skandal bantuan sosial yang pernah terjadi jatuh di salah satu dari tiga celah ini. Kami membangun DanaTerang untuk menutup ketiganya sekaligus."

---

## Slide 4 — SOLUSI: DanaTerang

**Evidence-first accountability platform**

- Organisasi unggah **bukti asli per milestone** (nota, invoice, foto, laporan)
- Sidik jari SHA-256 dihitung dari byte asli — **file tidak bisa ditukar**
- **3 Verifier independen** memeriksa dan memutuskan dengan tanda tangan kriptografis — **2 dari 3 harus cocok**
- Hasil keputusan + komitmen bukti **terkunci permanen di blockchain**
- Publik bisa melihat: bukti keberadaan, keputusan, dan jejak on-chain — **tanpa membuka data pribadi**

📊 *Catatan pembicara:* "Prinsipnya satu: bukti dulu, keputusan kemudian, pencatatan yang tidak bisa dimanipulasi. Dan yang paling penting — yang diawasi tidak boleh yang memverifikasi."

---

## Slide 5 — CARA KERJA: Dari upload sampai publik

1. **Organizer** membuat campaign + milestone → **Funder menandatangani pendanaan** (EIP-712, dicatat on-chain)
2. Organizer unggah bukti per milestone → **SHA-256 dihitung dari byte asli**, file tersimpan privat
3. **AI/OCR membaca** dokumen + screening otomatis (advisory)
4. **3 Verifier independen** menandatangani keputusan → quorum **2-dari-3** di kontrak
5. Paket bukti final → **SHA-256 di-anchor ke Sepolia** → status publik + link Etherscan
6. Funder mencatat pencairan dana — setiap rupiah terlacak ke bukti yang terverifikasi

📊 *Catatan pembicara:* "Setiap panah di diagram ini adalah transaksi nyata yang sudah kami jalankan di Sepolia — bukan mockup."

---

## Slide 6 — SISTEM BLOCKCHAIN: Tiga kontrak, satu prinsip

**Jaringan: Ethereum Sepolia (Etherscan) — sudah ter-deploy dan live**

| Kontrak | Fungsi |
|---|---|
| **PeerReviewQuorum** | Roster 3 Verifier terkunci sejak deploy; vote EIP-712; finalisasi 2-dari-3; NO_QUORUM tanpa jalur admin |
| **CampaignRegistry** | Pendanaan campaign ditandatangani Funder via ecrecover on-chain — consent tidak bisa dipalsukan relayer |
| **ProofAnchor** | Komitmen SHA-256 paket bukti final — satu proof ID, satu hash, selamanya |

- Relayer hanya mengirim & membayar gas — **tidak bisa memilih hasil**
- Tidak ada owner, tidak ada delete, tidak ada jalur admin di ketiga kontrak
- Perubahan roster hanya lewat tanda tangan **2-dari-3 anggota lama**

📊 *Catatan pembicara:* "Yang kami simpan di chain bukan datanya — tapi sidik jarinya. Siapa pun bisa mengambil file asli, menghitung SHA-256-nya, dan mencocokkan dengan yang di chain. Cocok = bukti asli. Beda satu bit pun = ada yang dimanipulasi."

---

## Slide 7 — SISTEM AI/OCR: Mesin membantu, manusia memutuskan

- **Tesseract.js** (Indonesia + Inggris, lokal — tanpa cloud untuk privasi) membaca nota/invoice: vendor, tanggal, jumlah, nomor invoice
- **Gemini AI** memperkaya hasil baca (fail-open: kalau AI gagal, pipeline tetap jalan dengan Tesseract)
- **Screening deterministik**: jumlah vs anggaran milestone, mata uang, tanggal janggal, dugaan duplikat
- **Privasi**: teks lengkap OCR hanya untuk 3 Verifier yang ditugaskan; yang di-commit ke chain hanya **hash keluaran AI**
- **Hasil AI = advisory, bukan vonis** — keputusan final tetap quorum manusia

📊 *Catatan pembicara:* "AI di sini bukan pengganti Verifier — dia asisten yang membuat 3 manusia itu mustahil melewatkan kejanggalan. Dan hash keluaran AI ikut terkunci di chain — kalau ada yang mengedit hasil OCR di database, ketahuan secara matematis."

---

## Slide 8 — KEAMANAN & PRIVASI: Yang bisa dipalsukan mana?

- File ditukar setelah verifikasi → **hash di chain tidak cocok** → ketahuan
- Hasil OCR diedit di database → **ocrOutputHash terkunci on-chain** → ketahuan
- Verifier "dijatah" → 3 organisasi independen, 2 tanda tangan cocok, tanpa jalur admin
- Admin menamper data → **tidak ada tombol vote/hapus** — hasil quorum final
- Data penerima bocor → file asli privat, publik hanya hash + status — **transparansi tanpa menjual data**
- Roster diganti diam-diam → butuh tanda tangan 2-dari-3 anggota lama, tercatat di chain

📊 *Catatan pembicara:* "Setiap serangan yang pernah terjadi di kasus nyata — kami punya satu pagar untuk masing-masing. Dan yang membuatnya kuat: pagar ini bukan kebijakan internal yang bisa diubah — dia berupa kode yang sudah ter-deploy di blockchain."

---

## Slide 9 — YANG SUDAH BERJALAN (BUKAN KONSEP)

- ✅ **3 kontrak live di Sepolia**: PeerReviewQuorum · ProofAnchor · CampaignRegistry *(link Etherscan)*
- ✅ Aplikasi penuh: registration/RBAC, campaign + milestone, upload bukti privat, OCR + AI, review portal Verifier, payment reports, public audit page
- ✅ Database produksi-ready: PostgreSQL hosted (Supabase), migrasi lengkap 014
- ✅ End-to-end teruji: bind wallet → pendanaan bertanda tangan → upload → OCR → quorum 2-dari-3 → proof ter-anchor
- ✅ Test suite penuh: API, kontrak (in-process EVM), browser E2E

📊 *Catatan pembicara:* "Ini bukan whitepaper. Ketiga kontraknya sudah di Sepolia — bisa dibuka di Etherscan sekarang juga. Alur penuhnya sudah kami jalankan: dari bukti diunggah sampai komitmen ter-anchor."

---

## Slide 10 — PENUTUP: Transparansi yang bisa dibuktikan, bukan dijanjikan

> *"Setiap rupiah program sosial meninggalkan jejak yang tidak bisa dihapus."*

- Organizer: kelola program dengan bukti yang **memuliakan, bukan membebani**
- Funder: danai dengan **kepastian** — setiap tahap terverifikasi sebelum dicatat
- Verifier: putuskan secara **independen**, bertanggung jawab selamanya
- Publik: **lihat sendiri** — di Etherscan, bukan di siaran pers

**DanaTerang — dana terang karena buktinya terang.**

📊 *Catatan pembicara:* "Tutup dengan pertanyaan balik ke juri: 'Ketika Anda mendonasikan Rp100.000 untuk program sosial, apa yang membuat Anda percaya uang itu sampai?' — jawabannya adalah DanaTerang."

---

## Tips presentasi

1. Slide 2 adalah slide emosi — bacakan angka Rp10.000/paket perlahan, beri jeda.
2. Slide 6 & 7 jangan dibaca tabelnya — tunjukkan diagram alur + buka Etherscan live kalau internet memungkinkan.
3. Siapkan fallback demo lokal (in-process EVM) kalau koneksi Sepolia lambat.
4. Angka penting yang harus hafal di luar kepala: **Rp10.000/paket · Rp250 M · 3 Verifier · 2-dari-3 · IPK 37/100 · Rp78,2 T**.
