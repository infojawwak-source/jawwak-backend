// ══════════════════════════════════════════════
// سيرفر جوّك الخلفي — نسخة Duffel + تحويل عملة تلقائي لجنيه مصري
// وظيفته: يستقبل طلب بحث من الموقع، ينادي Duffel API بمفتاحك السري
// (اللي محدش يقدر يشوفه لأنه هنا في السيرفر مش في المتصفح)، يجيب أسعار حقيقية،
// يحوّلهم لجنيه مصري، ويرجعهم للموقع.
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

// ══════════════════════════════════════════════
// إعدادات التسعير — غيّرهم من هنا لو حبيت تعدّل النسب لاحقاً
// ══════════════════════════════════════════════
// تكلفة تدبير العملة (تحويل جنيه لدولار للدفع) — تكلفة حقيقية عليك، مش ربح
const CURRENCY_FEE_PERCENT = 5; // %
// هامش ربحك، بيتحط فوق التكلفة الحقيقية (بعد تدبير العملة)
const PROFIT_MARGIN_PERCENT = 6; // %

function duffelHeaders() {
  return {
    'Authorization': `Bearer ${DUFFEL_TOKEN}`,
    'Duffel-Version': DUFFEL_API_VERSION,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

// ══════════════════════════════════════════════
// تحويل العملة — بنجيب سعر الصرف من مصدر مجاني (fawazahmed0/currency-api عبر jsDelivr)
// وبنخزنه مؤقتاً لمدة ساعة عشان منطلبوش من غير داعي في كل عملية بحث
// ══════════════════════════════════════════════
let ratesCache = { rates: null, fetchedAt: 0 };
const RATES_CACHE_MS = 60 * 60 * 1000; // ساعة واحدة

async function getExchangeRates() {
  const now = Date.now();
  if (ratesCache.rates && (now - ratesCache.fetchedAt) < RATES_CACHE_MS) {
    return ratesCache.rates;
  }

  // بنجيب أسعار صرف USD لكل العملات دفعة واحدة (بيشمل EGP وEUR وGBP...)
  const url = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';
  const res = await fetch(url);
  if (!res.ok) throw new Error('تعذر جلب أسعار الصرف');

  const data = await res.json();
  // شكل الرد: { date: "...", usd: { egp: 48.5, eur: 0.92, gbp: 0.79, ... } }
  ratesCache = { rates: data.usd, fetchedAt: now };
  return ratesCache.rates;
}

// تحويل مبلغ من عملة معينة لجنيه مصري
async function convertToEGP(amount, fromCurrency) {
  const cur = (fromCurrency || 'USD').toLowerCase();
  if (cur === 'egp') return amount; // أصلاً بالجنيه، مفيش داعي للتحويل

  const rates = await getExchangeRates(); // rates دايماً أساسها USD
  const egpPerUsd = rates.egp;
  if (!egpPerUsd) throw new Error('سعر صرف الجنيه المصري غير متاح حالياً');

  if (cur === 'usd') {
    return amount * egpPerUsd;
  }

  // لو العملة مش USD (مثلاً EUR)، بنحول: مبلغ بالعملة دي → USD → EGP
  const currencyPerUsd = rates[cur];
  if (!currencyPerUsd) throw new Error(`سعر صرف ${fromCurrency} غير متاح حالياً`);

  const amountInUsd = amount / currencyPerUsd;
  return amountInUsd * egpPerUsd;
}

// ══════════════════════════════════════════════
// تطبيق تكلفة تدبير العملة وهامش الربح فوق السعر بالجنيه
// الترتيب مهم: تدبير العملة أولاً (تكلفة حقيقية)، وبعدين هامش الربح فوقها
// ══════════════════════════════════════════════
function applyPricing(egpAmount) {
  const afterCurrencyFee = egpAmount * (1 + CURRENCY_FEE_PERCENT / 100);
  const afterMargin = afterCurrencyFee * (1 + PROFIT_MARGIN_PERCENT / 100);
  return afterMargin;
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
    const formatted = await formatDuffelResults(offers);
    res.json({ flights: formatted, count: formatted.length, currency: 'EGP' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'حصل خطأ غير متوقع' });
  }
});

// ══════════════════════════════════════════════
// استخراج بيانات الأمتعة الحقيقية من العرض
// Duffel بترجع الأمتعة المسموحة لكل راكب/سيجمنت داخل passengers[].baggages[]
// ══════════════════════════════════════════════
function extractBaggageInfo(firstSegment) {
  const passengerData = firstSegment.passengers?.[0];
  const baggages = passengerData?.baggages || [];

  const checked = baggages.find(b => b.type === 'checked');
  const carryOn = baggages.find(b => b.type === 'carry_on');

  return {
    checkedIncluded: Boolean(checked && checked.quantity > 0),
    checkedQuantity: checked?.quantity || 0,
    carryOnIncluded: Boolean(carryOn && carryOn.quantity > 0),
    carryOnQuantity: carryOn?.quantity || 0,
  };
}

// ══════════════════════════════════════════════
// استخراج شروط الاسترداد الحقيقية من العرض
// Duffel بترجعها في conditions.refund_before_departure.allowed
// لو الحقل مش موجود خالص، معناه المعلومة غير مؤكدة من شركة الطيران (مش نفترض قابل للاسترداد)
// ══════════════════════════════════════════════
function extractRefundInfo(offer) {
  const refundCond = offer.conditions?.refund_before_departure;
  if (!refundCond) {
    return { refundable: null, penaltyAmount: null, penaltyCurrency: null }; // غير معروف
  }
  return {
    refundable: Boolean(refundCond.allowed),
    penaltyAmount: refundCond.penalty_amount ? Number(refundCond.penalty_amount) : 0,
    penaltyCurrency: refundCond.penalty_currency || null,
  };
}

// ══════════════════════════════════════════════
// تحويل رد Duffel المعقد لشكل بسيط يفهمه الموقع، مع تحويل السعر لجنيه مصري
// ══════════════════════════════════════════════
async function formatDuffelResults(offers) {
  const sliced = offers.slice(0, 15);

  const results = await Promise.all(sliced.map(async (offer) => {
    const firstSlice = offer.slices[0];
    const firstSegment = firstSlice.segments[0];
    const lastSegment = firstSlice.segments[firstSlice.segments.length - 1];
    const stops = firstSlice.segments.length - 1;

    const originalAmount = Number(offer.total_amount);
    const originalCurrency = offer.total_currency;

    let priceEGP;
    try {
      const rawEGP = await convertToEGP(originalAmount, originalCurrency);
      priceEGP = Math.round(applyPricing(rawEGP));
    } catch (e) {
      console.error('فشل تحويل العملة، هيتم إرجاع السعر الأصلي:', e.message);
      priceEGP = Math.round(applyPricing(originalAmount)); // احتياطي لو فشل التحويل لأي سبب
    }

    const baggage = extractBaggageInfo(firstSegment);
    const refund = extractRefundInfo(offer);

    // لو فيه رحلة عودة (slice تاني)، نستخرج بياناتها بنفس الطريقة
    let returnLeg = null;
    if (offer.slices.length > 1) {
      const retSlice = offer.slices[1];
      const retFirstSeg = retSlice.segments[0];
      const retLastSeg = retSlice.segments[retSlice.segments.length - 1];
      returnLeg = {
        from: retFirstSeg.origin?.iata_code,
        to: retLastSeg.destination?.iata_code,
        depTime: (retFirstSeg.departing_at || '').slice(11, 16),
        arrTime: (retLastSeg.arriving_at || '').slice(11, 16),
        duration: (retSlice.duration || '').replace('PT', '').toLowerCase(),
        stops: retSlice.segments.length - 1,
        flightNumber: (offer.owner?.iata_code || '') + (retFirstSeg.operating_carrier_flight_number || retFirstSeg.marketing_carrier_flight_number || ''),
      };
    }

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
      returnLeg, // null لو رحلة ذهاب فقط، أو بيانات رحلة العودة الحقيقية
      price: priceEGP,
      currency: 'EGP',
      originalPrice: Math.round(originalAmount),
      originalCurrency,
      seatsLeft: firstSegment.available_seats ?? 9,
      cabin: firstSegment.passengers?.[0]?.cabin_class_marketing_name || cabin,
      // بيانات حقيقية من Duffel — مش قيم ثابتة
      baggage: {
        checkedIncluded: baggage.checkedIncluded,
        checkedQuantity: baggage.checkedQuantity,
        carryOnIncluded: baggage.carryOnIncluded,
        carryOnQuantity: baggage.carryOnQuantity,
      },
      refundable: refund.refundable, // true / false / null (null = غير مؤكد من شركة الطيران)
      refundPenalty: refund.penaltyAmount,
      refundPenaltyCurrency: refund.penaltyCurrency,
    };
  }));

  return results;
}

// ══════════════════════════════════════════════
// نقطة صحة السيرفر — للتأكد إنه شغال
// ══════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  let ratesOk = false;
  let egpRate = null;
  try {
    const rates = await getExchangeRates();
    egpRate = rates.egp;
    ratesOk = Boolean(egpRate);
  } catch (e) {
    ratesOk = false;
  }

  res.json({
    status: 'ok',
    duffelConfigured: Boolean(DUFFEL_TOKEN),
    mode: DUFFEL_TOKEN?.startsWith('duffel_test_') ? 'test' : (DUFFEL_TOKEN ? 'live' : 'not-configured'),
    currencyConversion: ratesOk ? 'ok' : 'unavailable',
    usdToEgpRate: egpRate,
  });
});

app.listen(PORT, () => {
  console.log(`✅ سيرفر جوّك شغال على http://localhost:${PORT}`);
  console.log(`   مصدر البيانات: Duffel API`);
  console.log(`   الأسعار بتترجع بالجنيه المصري (EGP) تلقائياً`);
});
