# Merit Marketing Hub — Sahip Kılavuzu

Bu belge yazılımcılar için değil, uygulamanın sahibi için yazıldı. Teknik terim
kullanmadan, sırayla ne yapmanız gerektiğini anlatır.

---

## 1. Uygulama nedir, verileriniz nerede durur?

Merit Marketing Hub artık bir Windows programıdır. Bilgisayara kurulur ve
**internet olmadan da çalışır**.

Misafir kayıtları, rezervasyonlar, notlar ve fotoğraflar bilgisayarınızda,
programın kendi klasöründen **ayrı** bir yerde durur:

```
C:\Users\<kullanıcı adınız>\AppData\Roaming\Merit Marketing Hub\
```

Bu ayrım önemlidir: **program güncellenince verileriniz silinmez.** Güncelleme
sadece programın kendisini değiştirir.

---

## 2. İlk kurulumda ne olur?

Programda **hazır kullanıcı yoktur**. Örnek misafir, örnek rezervasyon veya
hazır şifre de yoktur. Program tamamen boş başlar.

İlk açılışta sizden bir **yönetici hesabı** oluşturmanız istenir:

1. Kullanıcı adı yazın (örnek: `kerem`)
2. Şifre yazın — **en az 10 karakter**
3. Şifreyi tekrar yazın
4. Kaydedin

Bu hesap sizin ana yönetici hesabınızdır.

> **Önemli:** Bu şifreyi unutmayın. Arka kapı, gizli şifre veya "şifremi
> unuttum" yoktur. Bu bir eksiklik değil, bilinçli bir güvenlik kararıdır —
> böyle bir kapı olsaydı, onu sizden başkası da kullanabilirdi.

Sonraki adımlar:

1. **Pazarlama Profili** oluşturun (personelin adı)
2. O profile bağlı bir **Kullanıcı Hesabı** oluşturun
3. Artık misafir ve rezervasyon girebilirsiniz

---

## 3. Silinen Rezervasyonlar (yeni özellik)

Rezervasyon silmek artık kaydı **yok etmez**. Kayıt veritabanında kalır, ama:

- Normal rezervasyon listesinde **görünmez**
- Sayımlara, takvime ve raporlara **girmez**
- Ayrı bir **SİLİNENLER** sekmesinde durur

| Rol | Silinenler sekmesini görür mü? | Silebilir mi? |
|---|---|---|
| ADMIN | Evet | **Evet** |
| MANAGER | Evet | Hayır |
| MARKETING | **Hayır** | Hayır |

Silerken **sebep yazmak zorunludur**. Kim sildi, ne zaman sildi ve neden sildi
kayda geçer.

Pazarlama personeli silinen kayıtları hiçbir yoldan göremez — sekme gizli
olduğu için değil, program izin vermediği için.

---

## 4. Yedekleme — en önemli bölüm

### Yedek nasıl alınır?

Ayarlar → **Şimdi Yedekle**. Bu kadar.

### Program kendi kendine ne zaman yedek alır?

- Güncelleme kurulmadan önce
- Veritabanı yapısı değişmeden önce
- Yedek geri yüklenmeden önce

Yani riskli her işlemden önce otomatik güvenlik kopyası alınır.

### Yedekler nerede?

```
C:\Users\<kullanıcı adınız>\AppData\Roaming\Merit Marketing Hub\backups\
```

> **Tavsiye:** Ayda bir bu klasördeki en yeni dosyayı bir USB belleğe veya
> harici diske kopyalayın. Bilgisayar çalınırsa ya da bozulursa, tek kopyanız
> o bilgisayarda olmasın.

### Yedek geri yükleme

Ayarlar → **Geri Yükle** → dosyayı seçin.

Program önce dosyayı kontrol eder, sonra mevcut verilerinizin güvenlik kopyasını
alır, sonra geri yükler. **Bir şeyler ters giderse mevcut verileriniz olduğu
gibi kalır.**

---

## 5. Yeni sürüm çıkarma (versiyon)

### Versiyon numarası ne anlama gelir?

| Değişim | Ne zaman |
|---|---|
| `1.0.0 → 1.0.1` | Hata düzeltildi |
| `1.0.1 → 1.1.0` | Yeni özellik eklendi |
| `1.1.0 → 2.0.0` | Kullanım şekli köklü değişti |

### Nasıl yapılır?

Windows'ta PowerShell açın, proje klasörüne gidin ve yazın:

```powershell
./scripts/release/Release-Merit.ps1 -Version 1.0.1 -Channel stable
```

Program önce **kontrol eder**. Bir sorun varsa `BLOCKED` yazar ve ne yapmanız
gerektiğini söyler. Örneğin:

- Testler başarısızsa → durur
- Kaydedilmemiş değişiklik varsa → durur
- `crm.ico` simgesi eksikse → durur

Bu kontroller sizi korumak içindir. `BLOCKED` gördüğünüzde altındaki açıklamayı
okuyun ve onu düzeltin.

Başarılı olursa kurulum dosyası şurada olur:

```
out\make\...\MeritMarketingHub-Setup.exe
```

---

## 6. GitHub'a gönderirken hata alırsanız

Bazen `git push` komutu **403** hatası verir. Bu sizin hatanız değildir — izin
veya yetki ile ilgilidir.

**Yaptığınız iş kaybolmaz.** Şunu çalıştırın:

```powershell
./scripts/recovery/Recover-Push403.ps1
```

Bu komut `recovery` adında bir klasör oluşturur. O klasörü, GitHub'a
bağlanabilen bir bilgisayara kopyalayın. İçindeki `manifest.txt` dosyası ne
yapılacağını adım adım anlatır.

Bu komut **hiçbir şeyi silmez ve geri almaz.**

---

## 7. Şu anda sizden beklenen iki şey

Bu ikisi olmadan da program çalışır, ama profesyonel bir kurulum için gereklidir:

### a) `crm.ico` simge dosyası

Hazırladığınızı söylediğiniz simge dosyası şu anda projede **yok**. Bulup
şuraya koyun:

```
assets\crm.ico
```

Koyulmazsa program Electron'un varsayılan simgesiyle paketlenir. Sizin
tasarımınızın yerine başka bir simge **uydurulmadı** — bu bilinçli bir tercih.

### b) Kod imzalama sertifikası (Code Signing Certificate)

Sertifika olmadan Windows, programı ilk çalıştıran kişiye "bilinmeyen yayıncı"
uyarısı gösterir. Program çalışır, ama kullanıcı tedirgin olur.

Sertifika satın aldığınızda bize söyleyin; yapılandırma zaten hazır, sadece
dosyanın yolunu ve şifresini eklemek gerekir.

---

## 8. Bir sorun olursa ne yapmalısınız?

1. **Yeniden kurmayın.** Bu genelde yardımcı olmaz ve durumu karıştırır.
2. Şu klasörün tamamını güvenli bir yere kopyalayın:
   `C:\Users\<kullanıcı adınız>\AppData\Roaming\Merit Marketing Hub\`
3. Program bir hata mesajı gösterdiyse **ekran görüntüsü** alın.
4. `logs\merit.log` dosyasını da kopyalayın.
5. Bunları geliştiriciye iletin.

Program, veritabanını güvenle açamadığında **hiçbir şeye dokunmaz** ve boş bir
veritabanı oluşturmaz. Verileriniz olduğu yerde durur.
