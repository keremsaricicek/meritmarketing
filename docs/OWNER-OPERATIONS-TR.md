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

> Otomatik güncelleme şu anda **kapalıdır**; nedeni madde 8'de anlatılmıştır.
> Yeni sürümler şimdilik elden kurulur ve bu da verilerinize dokunmaz.

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

## 4. Bildirimler (zil simgesi)

Sağ üstteki zil çalışır ve kime ne gösterileceği role göre değişir:

| Kim | Ne görür |
|---|---|
| **Müdür** | Personelin yaptığı işlemler — rezervasyon, misafir, not, profil |
| **Pazarlama** | Kendisine atanan misafirler, soğuyan misafirleri, yaklaşan girişleri |

İki tür bildirim vardır ve farkları önemlidir:

- **Olay bildirimi** bir kez olur ve kalır. "Size yeni misafir atandı" gibi.
- **Durum bildirimi** kendiliğinden değişir. "Bu misafir soğudu" ya da "yarın
  giriş var" gibi. Bu tür bildirimler her açılışta yeniden hesaplanır: durum
  geçtiyse bildirim **kendiliğinden kaybolur.**

Bu yüzden iptal edilen bir rezervasyonun giriş hatırlatması ortadan kalkar.
Olmayan bir giriş için hatırlatma görmek, hiç hatırlatma görmemekten kötüdür —
birisi ona göre hareket eder.

Kendinizin yaptığı işlem size bildirim olarak gelmez; ne yaptığınızı zaten
biliyorsunuz.

Müdür bildirim akışı istenmezse Ayarlar'dan kapatılabilir.

---

## 5. Yedekleme — en önemli bölüm

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

## 6. Yeni sürüm çıkarma (versiyon)

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

## 7. GitHub'a gönderirken hata alırsanız

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

## 8. Otomatik güncelleme — şu anda KAPALI, ve nedeni

Program güncellendiğinde verileriniz silinmez, ve güncellemeden önce otomatik
yedek alınır. Bu kısım hazır ve test edilmiş durumdadır.

**Ama otomatik güncelleme şu anda kapalıdır ve açılmamalıdır.**

Sebebi tek cümleyle: **indirilen kurulum dosyasının imzası doğrulanmıyor.**
Yani güncelleme sunucusunu ele geçiren biri, sizin bilgisayarınıza istediği
programı kurdurabilirdi. Kilidi takmış ama çevirmemiş olmak gibidir.

Bu düzelene kadar yeni sürümler **elden kurulur**: kurulum dosyasını siz
indirir, siz çalıştırırsınız. Verileriniz yine korunur.

Açılabilmesi için gereken iki şey:

1. Kod imzalama sertifikası (aşağıda, madde 9-b).
2. Kurulum paketleyicisi ile güncelleme istemcisinin uyumlu hale getirilmesi —
   şu an ikisi farklı biçim bekliyor. Bu bizim işimiz, sizin değil.

Bu bir eksiklik değil, bilerek verilmiş bir karardır. Çalışmayan bir güvenlik
kontrolünü "var" saymaktansa, özelliği kapalı tutmak doğrudur.

---

## 9. Şu anda sizden beklenenler

Bunlar olmadan da program çalışır, ama profesyonel bir kurulum için gereklidir:

### a) `crm.ico` simge dosyası ve `logo.png`

Hazırladığınızı söylediğiniz simge dosyası şu anda projede **yok**. Bulup
şuraya koyun:

```
assets\crm.ico
```

Program içindeki logo (`logo.png`) da eksiktir; şimdilik yerine "M" harfi
görünür. Koyulmazsa program Electron'un varsayılan simgesiyle paketlenir. Sizin
tasarımınızın yerine başka bir simge **uydurulmadı** — bu bilinçli bir tercih.

### b) Kod imzalama sertifikası (Code Signing Certificate)

Sertifika olmadan Windows, programı ilk çalıştıran kişiye "bilinmeyen yayıncı"
uyarısı gösterir. Program çalışır, ama kullanıcı tedirgin olur. Sertifika ayrıca
otomatik güncellemenin açılabilmesi için de gereklidir (madde 8).

Sertifika satın aldığınızda bize söyleyin; yapılandırma zaten hazır, sadece
dosyanın yolunu ve şifresini eklemek gerekir.

### c) Bir Windows bilgisayarda ilk kurulumun denenmesi

Kurulum dosyası (`MeritMarketingHub-Setup.exe`) **henüz hiç çalıştırılmadı** —
elimizde Windows bilgisayar yok. Program kodu test edilmiştir; kurulumun kendisi
bir kez, bir Windows makinesinde denenmelidir. Bunu size açıkça söylüyoruz,
çünkü "denendi" demek kolay ama doğru olmazdı.

---

## 10. Bir sorun olursa ne yapmalısınız?

1. **Yeniden kurmayın.** Bu genelde yardımcı olmaz ve durumu karıştırır.
2. Şu klasörün tamamını güvenli bir yere kopyalayın:
   `C:\Users\<kullanıcı adınız>\AppData\Roaming\Merit Marketing Hub\`
3. Program bir hata mesajı gösterdiyse **ekran görüntüsü** alın.
4. `logs\merit.log` dosyasını da kopyalayın.
5. Bunları geliştiriciye iletin.

Program, veritabanını güvenle açamadığında **hiçbir şeye dokunmaz** ve boş bir
veritabanı oluşturmaz. Verileriniz olduğu yerde durur.


---

## Otomatik yedekleme

Ayarlar ekranındaki **Otomatik Yedekleme** artık gerçekten çalışıyor. Daha önce
seçiminiz kaydediliyordu ama hiçbir yedek alınmıyordu — bunu ancak yedeğe
ihtiyacınız olduğu gün fark ederdiniz. Şimdi düzeltildi.

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| Otomatik Yedekleme | açık | Kapatırsanız hiç yedek alınmaz |
| Sıklık | Başlangıç | `Başlangıç` her açılışta · `Günlük` günde bir kez · `Haftalık` 7 günde bir |
| Saklanacak yedek | 10 | Kaç **otomatik** yedeğin tutulacağı |

Üç şey önemli:

- **Gün hesabı takvim günüdür.** Sabah 09:00'da ve ertesi sabah 08:00'de
  çalıştığınızda bu iki ayrı gündür — aradan 24 saat geçmemiş olsa bile ikinci
  gün için de yedek alınır.
- **Elle aldığınız yedekler asla silinmez.** Saklama sınırı yalnızca programın
  kendi aldığı otomatik yedekleri temizler.
- **Yedek alınamazsa program yine açılır.** Hata kaydedilir, çalışmanız engellenmez
  ve mevcut veritabanınıza hiçbir şey olmaz.

Otomatik yedeklerin dosya adı `-auto` ile biter, böylece listede ayırt edilir.

## Fotoğraf kırpma

Misafir veya profil fotoğrafını kırptığınızda **kırpılmış hâli kalıcı olarak
kaydedilir**. Önceden kırpma yalnızca ekranda doğru görünüyordu; programı kapatıp
açtığınızda eski fotoğraf geri geliyordu. Artık kırpılmış fotoğraf yeni bir dosya
olarak saklanır ve orijinali de silinmez — yanlış kırptıysanız kaybolmaz.

## Veri klasörünü açma

Ayarlar ekranındaki **Veri Klasörü** düğmesi artık gerçekten klasörü açıyor.
Önceden her seferinde hata veriyordu.

## Güncellemeler — bu sürümde kapalı

Bu ilk sürümde **otomatik güncelleme yoktur** ve program bunu kendi kodunda
engeller. Yeni sürüme geçmek için yeni kurulum dosyasını elle çalıştırırsınız.

Sebebi teknik ama önemli: güncelleme dosyasının imzası henüz doğrulanamıyor.
Doğrulanmadan otomatik indirme açılırsa, güncelleme sunucusunu ele geçiren biri
bilgisayarınızda istediği programı çalıştırabilir. Bu yüzden imza sertifikası
alınana kadar kapalı kalacak.

## Misafir arşivleme

Bir misafiri sildiğinizde aslında **arşivlenir**: aktif listelerden çıkar ama
rezervasyon geçmişi ve CRM notları saklanır. Uyarı penceresi artık bunu doğru
anlatıyor — daha önce "rezervasyonlar da silinecek" diyordu, ki bu doğru değildi.
