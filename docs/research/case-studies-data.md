# Riset Dukungan DanaTerang: Kasus Nyata, Data, dan Statistik

> Dokumen riset untuk materi pitch/demo. Semua angka dilengkapi sumber publik.
> Terakhir diperbarui: 2026-11-22.

## 1. Skala masalah: berapa besar uang yang mengalir tanpa transparansi?

| Indikator | Angka | Sumber |
|---|---|---|
| Anggaran Kemensos 2025 (setelah efisiensi) | **Rp78,2 triliun** | Kemenkeu |
| Perlindungan sosial tahun 2021 (masa pandemi) | **±Rp110 triliun** | Kemenkeu/DPR RI |
| Program PEN 2020 (total stimulus) | **Rp695,2 triliun**, termasuk **Rp203,9 triliun** perlindungan sosial | Kemenkeu |
| BLT Dana Desa/Bansos COVID 2020 | **Rp21 triliun** (Rp600 rb × 3 bulan) | Kemenkeu |
| Sembako 2020 | Kuota naik 15,2 → **20 juta KPM** | Kemensos |
| BST 2020 | hingga **9 juta KPM** | Kemensos |
| BLT Tunai COVID 2021 | **Rp12 triliun** ke **10 juta KPM** (realisasi 98,39% per Mei 2021) | Kemenkeu |
| Potensi penghematan jika subsidi & bansos tepat sasaran | **Rp101–127 triliun** | Pemerintah (Juni 2025) |

## 2. Kasus nyata yang setiap satuannya bisa dicegah/dideteksi DanaTerang

### 2.1 Korupsi Bansos COVID-19 — Juliari Batubara (Menteri Sosial)
- **Suap**: Rp32,48 miliar dari penunjukan rekanan penyedia bansos.
- **Modus kunci untuk demo**: *potongan Rp10.000 dari SETIAP paket bansos* di Jabodetabek — persis jenis manipulasi yang terlihat bila setiap paket punya bukti ter-hash on-chain dan dicocokkan dengan anggaran milestone.
- **Vonis**: 12 tahun penjara + denda Rp500 juta (23 Agustus 2021); penyitaan Rp14,5 miliar.
- **Peran DanaTerang**: quorum 3 Verifier independen menolak bukti yang tidak memenuhi anggaran milestone; komitmen on-chain membuat penunjukan rekanan sepihak tidak bisa dilakukan diam-diam.

### 2.2 Korupsi Bansos Presiden/Beras 2020
- Kerugian negara direvisi KPK menjadi **±Rp250 miliar** (awalnya ±Rp125 miliar); uang rampasan Rp16,2 miliar disetor ke kas negara (Agustus 2022).

### 2.3 Korupsi Penyaluran Bansos COVID-19 (6 tersangka)
- Kerugian negara **±Rp127,5 miliar**, suap **±Rp18,8 miliar**; melibatkan kepala daerah dan pejabat pengarah — bukti bahwa *meningkatnya jabatan* tidak menurunkan risiko tanpa sistem yang transparan.

### 2.4 Korupsi Bansos Kemensos (kasus beras)
- Negara diperkirakan rugi **±Rp200 miliar** dalam korupsi penyaluran/pengangkutan bansos beras.

### 2.5 Dugaan korupsi Bansos Pemprov Jawa Barat
- Kerugian **Rp165,4 miliar** dalam dana hibah dan bansos daerah.

### 2.6 Yayasan fiktif — dana hibah pendidikan (Bandung)
- Ketua yayasan ditahan atas dugaan penyalahgunaan dana hibah **Rp1,5 miliar**; sekolah yang didanai ternyata **tidak memiliki gedung, guru, dan siswa nyata**.
- **Peran DanaTerang**: evidence per milestone (foto kegiatan, daftar hadir, nota) yang diverifikasi quorum membuat yayasan fiktif tidak lolos verifikasi bukti pertama.

### 2.7 Korupsi tingkat desa/pemda (termasuk bansos desa)
- **592 kasus**, kerugian negara **Rp433,8 miliar** dalam tujuh tahun terakhir.

### 2.8 Pola modus korupsi dana hibah (kajian kasus Akidi Tio & lainnya)
- Proposal fiktif, potongan dana hibah (mark-up), rekayasa LPJ, suap, inflasi anggaran.
- **Pemetaan ke fitur DanaTerang**:
  - Proposal fiktif → bukti per milestone + quorum manusia 2-dari-3.
  - Potongan/mark-up → screening otomatis jumlah bukti vs anggaran milestone.
  - Rekayasa LPJ → hash SHA-256 dari byte file asli terkunci di Sepolia — LPJ tidak bisa diretrofit.
  - Suap ke verifier → 3 Verifier dari 3 organisasi berbeda, tanda tangan EIP-712 permanen.
  - Manipulasi oleh operator → tidak ada jalur admin di kontrak; komitmen immutable.

### 2.9 Privasi: kebocoran data bansos berskala besar
- **279 juta data pribadi** diduga bocor (2021, diduga BPJS Kesehatan) — dijual di forum underground.
- **102 juta data Kemensos** diduga bocor/dijual di dark web (2022).
- **1,2 juta NIK & KK penerima bansos** Jawa Tengah diduga bocor (2026, ditangani Pemprov & BSSN).
- **Pesan desain**: DanaTerang menyimpan file asli secara privat (hanya 3 Verifier yang ditugaskan), mempublikasikan **hanya komitmen hash + status**, dan membuktikan bahwa keluaran AI/OCR tidak dimanipulasi — transparansi TANPA menjual data penerima.

## 3. Statistik persepsi & kepercayaan publik

| Indikator | Angka | Sumber |
|---|---|---|
| IPK (CPI) Indonesia 2024 | **37/100**, peringkat **99/180** (naik 3 poin dari 2023) | Transparency International Indonesia / KPK |
| Catatan: skor 2025 dilaporkan turun kembali ke 34 (perlu verifikasi) | — | media, Feb 2026 |
| Basis data penerima bansos | Tidak satu pintu — tiap kementerian punya basis data sendiri (studi KPK, Integritas 2022) | KPK/jurnal |

**Narasi pitch**: skor IPK yang rendah bukan sekadar angka — kasus bansos di atas menunjukkan akar masalahnya adalah *ketiadaan bukti yang bisa dipercaya publik*, bukan kurangnya aturan.

## 4. Preseden global: blockchain untuk dana publik

| Inisiatif | Relevansi untuk DanaTerang |
|---|---|
| **World Bank FundsChain** (pilot Nigeria) — pencatatan & pelacakan dana pembangunan di ledger tamper-proof | Preseden langsung: dana program dilacak end-to-end di chain |
| **Laporan WEF "Exploring Blockchain Technology for Government Transparency"** (termasuk studi kasus korupsi pengadaan Kolombia) | Kerangka akademik: blockchain untuk procurement/transparansi publik |
| **World Bank blog "Enhancing Transparency: The impact of Blockchain-based Audit Trails"** (Sep 2025) | Audit trail berbasis blockchain meningkatkan akuntabilitas & kepercayaan publik |
| Literatur akademik 2025–2026 (procurement blockchain) | Manfaat yang konsisten dilaporkan: pengurangan fraud, transparansi, kepercayaan warga |

## 5. Peta "kasus → fitur DanaTerang" (untuk slide demo)

| Modus manipulasi | Kasus nyata | Fitur DanaTerang yang menutupnya |
|---|---|---|
| Potongan Rp10 rb per paket | Bansos COVID (Juliari) | Bukti per paket + screening jumlah vs anggaran + quorum |
| Rekayasa LPJ | Kasus dana hibah (Akidi Tio dkk.) | Hash byte asli terkunci di Sepolia; LPJ tidak bisa diretrofit |
| Yayasan fiktif | Hibah pendidikan Bandung Rp1,5 M | Verifikasi keberadaan lewat bukti kegiatan per milestone |
| Verifier "ojek" | Berbagai kasus bansos | 3 organisasi independen + tanda tangan EIP-712 permanen |
| Manipulasi oleh operator/admin | Korupsi pejabat pengelola bansos | Tanpa jalur admin di kontrak; komitmen immutable |
| Kebocoran data penerima | 279 jt / 102 jt / 1,2 jt data | Privat by default; publik hanya hash + status |
| Data tidak satu pintu | Studi KPK Integritas 2022 | Satu sumber komitmen on-chain yang bisa diverifikasi publik |

## 6. Sumber

- [KPK — KPK Tetapkan 6 Tersangka Korupsi Penyaluran Bansos COVID-19](https://www.kpk.go.id/id/ruang-informasi/berita/kpk-tetapkan-6-tersangka-korupsi-penyaluran-bantuan-sosial-covid-19)
- [KPK — Statistik Penindakan TPK](https://www.kpk.go.id/id/publikasi-data/statistik/penindakan-2)
- [KPK — Skor IPK 2024 Meningkat](https://www.kpk.go.id/id/ruang-informasi/berita/skor-ipk-2024-meningkat-kpk-dorong-penguatan-pemberantasan-korupsi)
- [Transparency International Indonesia — Indeks Persepsi Korupsi 2024](https://ti.or.id/indeks-persepsi-korupsi-2024-korupsi-demokrasi-dan-krisis-lingkungan)
- [Kemenkeu — Informasi APBN 2025 (PDF)](https://media.kemenkeu.go.id/getmedia/c4cc1854-96f4-42f4-95b8-94cf49a46f10/Informasi-APBN-Tahun-Anggaran-2025.pdf)
- [Hukumonline — Dana Hibah dan Bansos Banyak Disalahgunakan](https://www.hukumonline.com/berita/a/dana-hibah-dan-bansos-banyak-disalahgunakan-lt4f730af90063f)
- [Pemprov Jateng — Penanganan Dugaan Kebocoran Data Bansos](https://jatengprov.go.id/publik/dugaan-kebocoran-data-bansos-pemprov-jateng-sudah-tangani-dan-sistem-telah-pulih)
- [WEF — Exploring Blockchain Technology for Government Transparency (PDF)](https://www3.weforum.org/docs/WEF_Blockchain_Government_Transparency_Report.pdf)
- [World Bank — Enhancing Transparency: Blockchain-based Audit Trails](https://blogs.worldbank.org/en/governance/enhancing-transparency--the-impact-of-blockchain-based-audit-tra)
- [Detik — KPK: Kerugian Bansos Presiden 2020 Rp250 Miliar](https://news.detik.com/berita/d-7416969/melonjak-kpk-kini-sebut-kerugian-bansos-presiden-2020-rp-250-miliar)
- [Antara Mataram — Negara Rugi Rp200 Miliar Korupsi Bansos Kemensos](https://mataram.antaranews.com/berita/480585/kpk-negara-rugi-rp200-miliar-dalam-kasus-korupsi-bansos-kemensos)
