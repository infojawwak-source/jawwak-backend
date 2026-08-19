// ══════════════════════════════════════════════
// سيرفر جوّك الخلفي — نسخة Duffel
// وظيفته: يستقبل طلب بحث من الموقع، ينادي Duffel API بمفتاحك السري
// (اللي محدش يقدر يشوفه لأنه هنا في السيرفر مش في المتصفح)، ويرجع أسعار حقيقية
//
// ملاحظة: انتقلنا من Amadeus لـ Duffel لأن بوابة Amadeus Self-Service
// اتقفلت رسمياً في يوليو 2026. Duffel بديل مباشر ومناسب لنفس الغرض.
// ══════════════════════════════════════════════
import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DUFFEL_TOKEN = process.env.DUFFEL_ACCESS_TOKEN;
const DUFFEL_BASE = 'https://api.duffel.com';
// Duffel بتحدد إصدار الـ API برقم تاريخ ثابت في الهيدر (مش في الرابط)
const DUFFEL_API_VERSION = 'v2';

function duffelHeaders() {
  return {
    'Authorization': `Bearer ${DUFFEL_TOKEN}`,
    'Duffel-Version': DUFFEL_API_VERSION,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

// ══════════════════════════════════════════════
// نقطة البحث عن رحلات — دي اللي الموقع هينادي عليها
// ══════════════════════════════════════════════
app.post('/api/search-flights', async (req, res) => {
  try {
    const { from, to, departDate, returnDate, adults = 1, children = 0, cabin = 'economy' } = req.body;

    if (!from || !to || !departDate) {
      return res.status(400).json({ error: 'محتاج تحدد نقطة الانطلاق والوصول وتاريخ السفر' });
    }

    // بناء قائمة المسافرين (Duffel بتطلبهم كمصفوفة كائنات)
    const passengers = [];
    for (let i = 0; i < Number(adults); i++) passengers.push({ type: 'adult' });
    for (let i = 0; i < Number(children); i++) passengers.push({ type: 'child' });

    // بناء المسارات (slices) — رحلة ذهاب، وذهاب وعودة لو فيه returnDate
    const slices = [
      { origin: from, destination: to, departure_date: departDate },
    ];
    if (returnDate) {
      slices.push({ origin: to, destination: from, departure_date: returnDate });
    }

    // الخطوة 1: إنشاء "طلب عرض أسعار" (Offer Request)
    const offerReqRes = await fetch(`${DUFFEL_BASE}/air/offer_requests?return_offers=true`, {
      method: 'POST',
      headers: duffelHeaders(),
      body: JSON.stringify({
        data: {
          slices,
          passengers,
          cabin_class: cabin.toLowerCase(),
        },
      }),
    });

    if (!offerReqRes.ok) {
      const errBody = await offerReqRes.json().catch(() => ({}));
      return res.status(offerReqRes.status).json({
        error: 'حصل خطأ في جلب الرحلات من Duffel',
        details: errBody,
      });
    }

    const offerReqData = await offerReqRes.json();
    const offers = offerReqData.data?.offers || [];
    const formatted = formatDuffelResults(offers);
    res.json({ flights: formatted, count: formatted.length });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'حصل خطأ غير متوقع' });
  }
});

// ══════════════════════════════════════════════
// تحويل رد Duffel المعقد لشكل بسيط يفهمه الموقع
// ══════════════════════════════════════════════
function formatDuffelResults(offers) {
  return offers.slice(0, 15).map((offer) => {
    const firstSlice = offer.slices[0];
    const firstSegment = firstSlice.segments[0];
    const lastSegment = firstSlice.segments[firstSlice.segments.length - 1];
    const stops = firstSlice.segments.length - 1;

    return {
      id: offer.id,
      airlineCode: offer.owner?.iata_code || '',
      airlineName: offer.owner?.name || 'شركة طيران',
      flightNumber: (offer.owner?.iata_code || '') + (firstSegment.operating_carrier_flight_number || firstSegment.marketing_carrier_flight_number || ''),
      from: firstSegment.origin?.iata_code,
      to: lastSegment.destination?.iata_code,
      depTime: (firstSegment.departing_at || '').slice(11, 16),
      arrTime: (lastSegment.arriving_at || '').slice(11, 16),
      duration: (firstSlice.duration || '').replace('PT', '').toLowerCase(),
      stops,
      price: Math.round(Number(offer.total_amount)),
      currency: offer.total_currency,
      seatsLeft: firstSegment.available_seats ?? 9,
      cabin: firstSegment.passengers?.[0]?.cabin_class_marketing_name || cabin,
    };
  });
}

// ══════════════════════════════════════════════
// نقطة صحة السيرفر — للتأكد إنه شغال
// ══════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    duffelConfigured: Boolean(DUFFEL_TOKEN),
    mode: DUFFEL_TOKEN?.startsWith('duffel_test_') ? 'test' : (DUFFEL_TOKEN ? 'live' : 'not-configured'),
  });
});

app.listen(PORT, () => {
  console.log(`✅ سيرفر جوّك شغال على http://localhost:${PORT}`);
  console.log(`   مصدر البيانات: Duffel API`);
});
