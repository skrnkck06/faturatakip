// Her 10 dakikada bir GitHub Actions tarafından çalıştırılır.
// Firestore'daki bildirim ayarlarını ve faturaları okur, zamanı gelenleri FCM ile cihazlara gönderir.
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const TZ = "Europe/Istanbul";

const money = n => Number(n || 0).toLocaleString("tr-TR", { style: "currency", currency: "TRY" });
const tm = t => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
function nowTR() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  const today = `${p.year}-${p.month}-${p.day}`;
  return { today, min: Number(p.hour) * 60 + Number(p.minute), dow: new Date(today + "T00:00:00Z").getUTCDay() }; // 0=Pazar … 6=Cumartesi
}
const dayNum = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const label = n => n < 0 ? Math.abs(n) + " gün gecikti" : n === 0 ? "Bugün son gün" : n + " gün kaldı";

async function processUser(u, today, min, dow) {
  const notes = [];
  const cfg = (await u.collection("settings").doc("notif").get()).data();
  const devs = await u.collection("devices").get();
  notes.push("cihaz:" + devs.size);
  if (!cfg) return notes.concat("AYAR YOK (siteden ayar kaydedilmemiş / Firestore kuralları)").join(" | ");
  if (devs.empty) return notes.concat("kayıtlı cihaz yok").join(" | ");

  const stRef = u.collection("settings").doc("notifState");
  const st = (await stRef.get()).data() || {};
  const send = async data => {
    const r = await admin.messaging().sendEachForMulticast({
      tokens: devs.docs.map(d => d.id), data,
      webpush: { headers: { Urgency: "high", TTL: "3600" } }
    });
    r.responses.forEach((x, i) => {
      const code = (x.error && x.error.code) || "";
      if (!x.success) notes.push("gönderim hatası: " + (code || (x.error && x.error.message)));
      if (!x.success && /not-registered|invalid-registration-token|invalid-argument/.test(code)) devs.docs[i].ref.delete();
    });
    return r.successCount;
  };

  const treq = (await u.collection("settings").doc("test").get()).data();
  if (treq && treq.req > (st.testDone || 0)) {
    const n = await send({ title: "Test bildirimi", body: "Sunucudan gelen bildirim çalışıyor.", tag: "fatura-test" });
    await stRef.set({ testDone: treq.req }, { merge: true });
    notes.push("test gönderildi:" + n);
  }

  let bills = null, allBills = null, infos = null;
  for (const k of ["late", "soon", "query"]) {
    const c = cfg[k];
    if (!c || !c.on) { notes.push(k + ":kapalı"); continue; }
    if (c.text === false) { notes.push(k + ":yazılı bildirim kapalı"); continue; }
    // Önce güne bak: bugün seçili günlerden değilse bildirim gönderme (wd yoksa eski ayar: her gün)
    if (Array.isArray(c.wd) && !c.wd.includes(dow)) { notes.push(k + ":bugün seçili gün değil"); continue; }
    const s = st[k] || {};
    const ms = Math.max(2, Number(c.every) || 60) * (c.unit === "h" ? 60 : 1) * 60e3 - 2 * 60e3; // 2 dk tolerans
    let mark = null;
    if (c.mode === "daily") {
      for (const t of c.times || []) {
        const x = tm(t);
        if (min >= x && min - x <= 90 && !(s.d && s.d[t] === today)) { mark = t; break; }
      }
    } else if (c.mode === "window") {
      const f = tm(c.from || "00:00"), t = tm(c.to || "23:59");
      const inw = f <= t ? (min >= f && min <= t) : (min >= f || min <= t);
      if (!inw) { notes.push(k + ":saat aralığı dışında"); continue; }
      if (!s.t || Date.now() - s.t >= ms) mark = "i";
    } else if (!s.t || Date.now() - s.t >= ms) mark = "i";
    if (!mark) { notes.push(k + ":zamanı gelmedi"); continue; }

    let items, title, lines;
    if (k === "query") {
      // Son ödeme tarihi girilmiş ama o tarih için borç kaydı olmayan faturalar
      if (!allBills) allBills = (await u.collection("bills").get()).docs.map(d => d.data());
      if (!infos) infos = (await u.collection("info").get()).docs.map(d => ({ id: d.id, ...d.data() }));
      const lim = Number(c.days) || 3;
      items = infos
        .filter(i => i.due && i.noDebtFor !== i.due && !allBills.some(b => b.due === i.due && (b.infoId === i.id || (!b.infoId && b.shop === i.shop && b.type === i.type && b.provider === i.provider))))
        .map(i => ({ ...i, n: dayNum(i.due) - dayNum(today) }))
        .filter(i => i.n >= 0 && i.n <= lim)
        .sort((a, b) => a.due.localeCompare(b.due));
      if (!items.length) { notes.push(k + ":borcu sorgulanacak fatura yok"); continue; }
      lines = items.slice(0, 4).map(i => `${i.shop} · ${i.type} · ${label(i.n)}`);
      if (items.length > 4) lines.push(`+ ${items.length - 4} fatura daha`);
      title = "Borç sorgula: " + items.length + " fatura";
    } else {
      if (!bills) bills = (await u.collection("bills").get()).docs.map(d => d.data()).filter(b => !b.paid && b.due);
      items = bills.map(b => ({ ...b, n: dayNum(b.due) - dayNum(today) }))
        .filter(b => k === "late" ? b.n < 0 : b.n >= 0 && b.n <= (Number(c.days) || 3))
        .sort((a, b) => a.due.localeCompare(b.due));
      if (!items.length) { notes.push(k + ":bildirilecek fatura yok"); continue; }
      const total = items.reduce((a, b) => a + Number(b.amount || 0), 0);
      lines = items.slice(0, 4).map(b => `${b.shop} · ${b.type} · ${money(b.amount)} · ${label(b.n)}`);
      if (items.length > 4) lines.push(`+ ${items.length - 4} fatura daha`);
      title = (k === "late" ? "Gecikmiş ödeme: " : "Yaklaşan ödeme: ") + items.length + " fatura · " + money(total);
    }
    const n = await send({ title, body: lines.join("\n"), tag: "fatura-" + k });

    const ns = mark === "i" ? { t: Date.now() }
      : { d: { ...Object.fromEntries(Object.entries(s.d || {}).filter(([, v]) => v === today)), [mark]: today } };
    await stRef.set({ [k]: ns }, { merge: true });
    notes.push(k + ":" + items.length + " fatura → " + n + " cihaza gönderildi");
  }
  return notes.join(" | ");
}

(async () => {
  const { today, min, dow } = nowTR();
  console.log("Türkiye saati:", today, Math.floor(min / 60) + ":" + String(min % 60).padStart(2, "0"));
  const users = await db.collection("users").listDocuments();
  console.log("Kullanıcı sayısı:", users.length);
  for (const u of users) {
    let note;
    try { note = await processUser(u, today, min, dow); } catch (e) { note = "HATA: " + (e.message || e); }
    console.log(u.id, "→", note);
    try { await u.collection("settings").doc("serverLog").set({ at: new Date().toISOString(), note }); } catch (e) { console.error("log yazılamadı", e.message); }
  }
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
