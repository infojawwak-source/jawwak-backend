// ══════════════════════════════════════════════
// سيرفر جوّك الخلفي — Launch Ready
// Duffel + تحويل عملة إلى EGP + تحقق من السعر قبل تأكيد الطلب
// + إرسال تأكيد الحجز عبر البريد الإلكتروني
// ══════════════════════════════════════════════
import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const DUFFEL_TOKEN = process.env.DUFFEL_ACCESS_TOKEN;
const DUFFEL_BASE = 'https://api.duffel.com';
const DUFFEL_API_VERSION = 'v2';
const FRONTEND_URL = process.env.FRONTEND_URL || '';

// البريد الإلكتروني — ضع القيم في Render Environment Variables
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || 'jawwak.eg@gmail.com';

// Supabase — يُستخدم من السيرفر فقط (لا يتم إرساله للمتصفح).
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';

// لوحة التحكم — نحتفظ بكلمة المرور الحالية، ويمكن تغييرها لاحقاً عبر Render Environment باسم ADMIN_PASSWORD.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Jawwak@2026';

// حد زمني لحماية السيرفر من الطلبات المعلقة.
const DUFFEL_TIMEOUT_MS = 20_000;
const FX_TIMEOUT_MS = 10_000;

// التسعير
const CURRENCY_FEE_PERCENT = 0;
const PROFIT_MARGIN_PERCENT = 0;
const MAX_RESULTS = 35;

// حدود البحث
const MAX_ADULTS = 9;
const MAX_CHILDREN = 8;
const MAX_INFANTS = 9;
const IATA_RE = /^[A-Z]{3}$/;
const CABINS = new Set(['economy', 'premium_economy', 'business', 'first']);

// Rate limit بسيط داخل الذاكرة — مناسب للـlaunch، ويعاد ضبطه مع restart.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 30;
const rateBuckets = new Map();

const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://jawwak-eg.com',
  'https://www.jawwak-eg.com',
  'https://info-jawwak.workers.dev',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const configured = FRONTEND_URL.split(',').map(v => v.trim()).filter(Boolean);
    const allowed = new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
    return callback(null, allowed.has(origin));
  },
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Admin-Password'],
}));

app.use(express.json({ limit: '50kb' }));

function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || 'unknown')
    .split(',')[0]
    .trim();
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = getClientIp(req);
  let bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(key, bucket);
  }

  bucket.count += 1;

  if (bucket.count > RATE_MAX_REQUESTS) {
    const retryAfter = Math.ceil(
      (RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000
    );

    res.set('Retry-After', String(retryAfter));

    return res.status(429).json({
      error: 'طلبات كثيرة خلال وقت قصير. حاول مرة أخرى بعد قليل.'
    });
  }

  if (rateBuckets.size > 5000) {
    for (const [ip, item] of rateBuckets) {
      if (now - item.startedAt >= RATE_WINDOW_MS) {
        rateBuckets.delete(ip);
      }
    }
  }

  next();
}

function duffelHeaders() {
  return {
    Authorization: `Bearer ${DUFFEL_TOKEN}`,
    'Duffel-Version': DUFFEL_API_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = DUFFEL_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(
        'انتهت مهلة الاتصال بالمصدر. حاول البحث مرة أخرى.'
      );
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════
// تحويل العملة
// ══════════════════════════════════════════════

let ratesCache = {
  rates: null,
  fetchedAt: 0
};

const RATES_CACHE_MS = 60 * 60 * 1000;

async function getExchangeRates() {
  const now = Date.now();

  if (
    ratesCache.rates &&
    now - ratesCache.fetchedAt < RATES_CACHE_MS
  ) {
    return ratesCache.rates;
  }

  const url =
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';

  const res = await fetchWithTimeout(
    url,
    {},
    FX_TIMEOUT_MS
  );

  if (!res.ok) {
    throw new Error('تعذر جلب أسعار الصرف حالياً');
  }

  const data = await res.json();

  if (!data?.usd || typeof data.usd !== 'object') {
    throw new Error(
      'بيانات أسعار الصرف غير صالحة حالياً'
    );
  }

  ratesCache = {
    rates: data.usd,
    fetchedAt: now
  };

  return ratesCache.rates;
}

async function convertToEGP(amount, fromCurrency) {
  const numericAmount = Number(amount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount < 0
  ) {
    throw new Error('قيمة السعر الأصلية غير صالحة');
  }

  const cur = String(
    fromCurrency || 'USD'
  ).toLowerCase();

  if (cur === 'egp') {
    return numericAmount;
  }

  const rates = await getExchangeRates();

  const egpPerUsd = Number(rates.egp);

  if (
    !Number.isFinite(egpPerUsd) ||
    egpPerUsd <= 0
  ) {
    throw new Error(
      'سعر صرف الجنيه المصري غير متاح حالياً'
    );
  }

  if (cur === 'usd') {
    return numericAmount * egpPerUsd;
  }

  const currencyPerUsd = Number(rates[cur]);

  if (
    !Number.isFinite(currencyPerUsd) ||
    currencyPerUsd <= 0
  ) {
    throw new Error(
      `سعر صرف ${fromCurrency} غير متاح حالياً`
    );
  }

  const amountInEGP =
    (numericAmount / currencyPerUsd) * egpPerUsd;

  if (
    !Number.isFinite(amountInEGP) ||
    amountInEGP < 0
  ) {
    throw new Error(
      'تعذر حساب السعر بالجنيه المصري'
    );
  }

  return amountInEGP;
}

function applyPricing(egpAmount) {
  const numericAmount = Number(egpAmount);

  if (
    !Number.isFinite(numericAmount) ||
    numericAmount < 0
  ) {
    throw new Error(
      'قيمة السعر بالجنيه غير صالحة'
    );
  }

  const afterCurrencyFee =
    numericAmount *
    (1 + CURRENCY_FEE_PERCENT / 100);

  const afterMargin =
    afterCurrencyFee *
    (1 + PROFIT_MARGIN_PERCENT / 100);

  if (
    !Number.isFinite(afterMargin) ||
    afterMargin < 0
  ) {
    throw new Error(
      'تعذر حساب السعر النهائي'
    );
  }

  return afterMargin;
}

function parseNonNegativeInt(
  value,
  fallback = 0
) {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return fallback;
  }

  if (!/^[0-9]+$/.test(String(value))) {
    return NaN;
  }

  return Number(value);
}

function validateSearchBody(body = {}) {
  const from = String(body.from || '')
    .trim()
    .toUpperCase();

  const to = String(body.to || '')
    .trim()
    .toUpperCase();

  const departDate = String(
    body.departDate || ''
  ).trim();

  const returnDate = body.returnDate
    ? String(body.returnDate).trim()
    : '';

  if (
    !IATA_RE.test(from) ||
    !IATA_RE.test(to)
  ) {
    return {
      error: 'بيانات المطارات غير صالحة.'
    };
  }

  if (from === to) {
    return {
      error:
        'مدينة المغادرة والوصول يجب أن تكونا مختلفتين.'
    };
  }

  const dep = new Date(
    `${departDate}T00:00:00Z`
  );

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(departDate) ||
    Number.isNaN(dep.getTime())
  ) {
    return {
      error: 'تاريخ السفر غير صالح.'
    };
  }

  if (returnDate) {
    const ret = new Date(
      `${returnDate}T00:00:00Z`
    );

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(returnDate) ||
      Number.isNaN(ret.getTime())
    ) {
      return {
        error: 'تاريخ العودة غير صالح.'
      };
    }

    if (ret < dep) {
      return {
        error:
          'تاريخ العودة يجب أن يكون بعد أو مساويًا لتاريخ الذهاب.'
      };
    }
  }

  const adults = parseNonNegativeInt(
    body.adults,
    1
  );

  const children = parseNonNegativeInt(
    body.children,
    0
  );

  const infants = parseNonNegativeInt(
    body.infants,
    0
  );

  if (
    ![adults, children, infants].every(
      Number.isInteger
    )
  ) {
    return {
      error: 'عدد المسافرين غير صالح.'
    };
  }

  if (
    adults < 1 ||
    adults > MAX_ADULTS
  ) {
    return {
      error:
        `عدد البالغين يجب أن يكون بين 1 و${MAX_ADULTS}.`
    };
  }

  if (
    children < 0 ||
    children > MAX_CHILDREN
  ) {
    return {
      error:
        `عدد الأطفال يجب ألا يتجاوز ${MAX_CHILDREN}.`
    };
  }

  if (
    infants < 0 ||
    infants > MAX_INFANTS ||
    infants > adults
  ) {
    return {
      error:
        'عدد الرضع يجب ألا يتجاوز عدد البالغين.'
    };
  }

  const cabin = String(
    body.cabin || 'economy'
  ).toLowerCase();

  if (!CABINS.has(cabin)) {
    return {
      error: 'درجة السفر غير صالحة.'
    };
  }

  return {
    value: {
      from,
      to,
      departDate,
      returnDate,
      adults,
      children,
      infants,
      cabin
    }
  };
}

function extractBaggageInfo(firstSegment) {
  const passengerData =
    firstSegment?.passengers?.[0];

  const baggages =
    passengerData?.baggages || [];

  const checked = baggages.find(
    b => b.type === 'checked'
  );

  const carryOn = baggages.find(
    b => b.type === 'carry_on'
  );

  return {
    checkedIncluded:
      Boolean(
        checked &&
        Number(checked.quantity) > 0
      ),

    checkedQuantity:
      Number(checked?.quantity || 0),

    carryOnIncluded:
      Boolean(
        carryOn &&
        Number(carryOn.quantity) > 0
      ),

    carryOnQuantity:
      Number(carryOn?.quantity || 0),
  };
}

function extractRefundInfo(offer) {
  const refundCond =
    offer?.conditions?.refund_before_departure;

  if (!refundCond) {
    return {
      refundable: null,
      penaltyAmount: null,
      penaltyCurrency: null
    };
  }

  return {
    refundable:
      Boolean(refundCond.allowed),

    penaltyAmount:
      refundCond.penalty_amount
        ? Number(refundCond.penalty_amount)
        : 0,

    penaltyCurrency:
      refundCond.penalty_currency || null,
  };
}

async function formatDuffelOffer(offer) {
  if (
    !offer?.slices?.length ||
    !offer.slices[0]?.segments?.length
  ) {
    throw new Error(
      'عرض الرحلة غير مكتمل'
    );
  }

  const firstSlice =
    offer.slices[0];

  const firstSegment =
    firstSlice.segments[0];

  const lastSegment =
    firstSlice.segments[
      firstSlice.segments.length - 1
    ];

  const originalAmount =
    Number(offer.total_amount);

  const originalCurrency =
    offer.total_currency;

  if (
    !Number.isFinite(originalAmount) ||
    originalAmount < 0 ||
    !originalCurrency
  ) {
    throw new Error(
      `بيانات السعر الأصلية غير صالحة للعرض ${offer.id || 'unknown'}`
    );
  }

  const rawEGP =
    await convertToEGP(
      originalAmount,
      originalCurrency
    );

  const finalPrice =
    Math.round(
      applyPricing(rawEGP)
    );

  if (
    !Number.isFinite(finalPrice) ||
    finalPrice < 0
  ) {
    throw new Error(
      'السعر النهائي غير صالح'
    );
  }

  const baggage =
    extractBaggageInfo(
      firstSegment
    );

  const refund =
    extractRefundInfo(offer);

  const operatingCarrier =
    firstSegment.operating_carrier;

  const marketingCarrier =
    firstSegment.marketing_carrier;

  const displayCarrier =
    operatingCarrier ||
    marketingCarrier;

  let returnLeg = null;

  if (
    offer.slices.length > 1 &&
    offer.slices[1]?.segments?.length
  ) {
    const retSlice =
      offer.slices[1];

    const retFirstSeg =
      retSlice.segments[0];

    const retLastSeg =
      retSlice.segments[
        retSlice.segments.length - 1
      ];

    const returnCarrier =
      retFirstSeg.operating_carrier ||
      retFirstSeg.marketing_carrier;

    returnLeg = {
      from:
        retFirstSeg.origin?.iata_code,

      to:
        retLastSeg.destination?.iata_code,

      depTime:
        String(
          retFirstSeg.departing_at || ''
        ).slice(11, 16),

      arrTime:
        String(
          retLastSeg.arriving_at || ''
        ).slice(11, 16),

      duration:
        String(
          retSlice.duration || ''
        )
          .replace('PT', '')
          .toLowerCase(),

      stops:
        Math.max(
          0,
          retSlice.segments.length - 1
        ),

      flightNumber:
        (returnCarrier?.iata_code || '') +
        (
          retFirstSeg.operating_carrier_flight_number ||
          retFirstSeg.marketing_carrier_flight_number ||
          ''
        ),
    };
  }

  return {
    id: offer.id,

    airlineCode:
      displayCarrier?.iata_code || '',

    airlineName:
      displayCarrier?.name ||
      'شركة طيران',

    flightNumber:
      (displayCarrier?.iata_code || '') +
      (
        firstSegment.operating_carrier_flight_number ||
        firstSegment.marketing_carrier_flight_number ||
        ''
      ),

    from:
      firstSegment.origin?.iata_code,

    to:
      lastSegment.destination?.iata_code,

    depTime:
      String(
        firstSegment.departing_at || ''
      ).slice(11, 16),

    arrTime:
      String(
        lastSegment.arriving_at || ''
      ).slice(11, 16),

    duration:
      String(
        firstSlice.duration || ''
      )
        .replace('PT', '')
        .toLowerCase(),

    stops:
      Math.max(
        0,
        firstSlice.segments.length - 1
      ),

    returnLeg,

    price: finalPrice,

    currency: 'EGP',

    originalPrice:
      Math.round(originalAmount),

    originalCurrency,

    seatsLeft:
      firstSegment.available_seats ?? null,

    cabin:
      firstSegment.passengers?.[0]
        ?.cabin_class_marketing_name ||
      'economy',

    baggage,

    refundable:
      refund.refundable,

    refundPenalty:
      refund.penaltyAmount,

    refundPenaltyCurrency:
      refund.penaltyCurrency,
  };
}

async function formatDuffelResults(
  offers
) {
  const results =
    await Promise.all(
      offers.map(
        async offer => {
          try {
            return await formatDuffelOffer(
              offer
            );
          } catch (e) {
            console.error(
              `تم استبعاد عرض بسبب مشكلة في السعر: ${offer?.id || 'unknown'} — ${e.message}`
            );

            return null;
          }
        }
      )
    );

  const sortedResults =
    results
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.price - b.price
      );

  const selectedResults = [];

  const remainingResults =
    [...sortedResults];

  const airlineCounts =
    new Map();

  while (
    selectedResults.length <
      MAX_RESULTS &&
    remainingResults.length
  ) {
    let bestIndex = 0;
    let bestScore = Infinity;

    for (
      let i = 0;
      i < remainingResults.length;
      i++
    ) {
      const flight =
        remainingResults[i];

      const airlineKey =
        flight.airlineCode ||
        flight.airlineName ||
        'unknown';

      const airlineCount =
        airlineCounts.get(
          airlineKey
        ) || 0;

      const diversityPenalty =
        airlineCount * 0.025;

      const score =
        flight.price *
        (1 + diversityPenalty);

      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    const selectedFlight =
      remainingResults.splice(
        bestIndex,
        1
      )[0];

    const airlineKey =
      selectedFlight.airlineCode ||
      selectedFlight.airlineName ||
      'unknown';

    airlineCounts.set(
      airlineKey,
      (
        airlineCounts.get(
          airlineKey
        ) || 0
      ) + 1
    );

    selectedResults.push(
      selectedFlight
    );
  }

  return selectedResults.sort(
    (a, b) =>
      a.price - b.price
  );
}

function duffelErrorMessage(
  status
) {
  if (status === 400) {
    return 'بيانات البحث غير مقبولة من مزود الرحلات. راجع بيانات الرحلة وحاول مرة أخرى.';
  }

  if (
    status === 401 ||
    status === 403
  ) {
    return 'تعذر الاتصال بمصدر الرحلات. يرجى المحاولة لاحقاً.';
  }

  if (status === 429) {
    return 'مصدر الرحلات مشغول حالياً. حاول مرة أخرى بعد قليل.';
  }

  if (status >= 500) {
    return 'مصدر الرحلات غير متاح مؤقتاً. حاول مرة أخرى بعد قليل.';
  }

  return 'حصل خطأ في جلب الرحلات. حاول مرة أخرى.';
}

// ══════════════════════════════════════════════
// البحث
// ══════════════════════════════════════════════

app.post(
  '/api/search-flights',
  rateLimit,
  async (req, res) => {
    try {
      if (!DUFFEL_TOKEN) {
        return res.status(503).json({
          error:
            'خدمة البحث غير مهيأة حالياً.'
        });
      }

      const validation =
        validateSearchBody(
          req.body
        );

      if (validation.error) {
        return res.status(400).json({
          error:
            validation.error
        });
      }

      const {
        from,
        to,
        departDate,
        returnDate,
        adults,
        children,
        infants,
        cabin
      } = validation.value;

      const passengers = [];

      for (
        let i = 0;
        i < adults;
        i++
      ) {
        passengers.push({
          type: 'adult'
        });
      }

      for (
        let i = 0;
        i < children;
        i++
      ) {
        passengers.push({
          type: 'child'
        });
      }

      for (
        let i = 0;
        i < infants;
        i++
      ) {
        passengers.push({
          type:
            'infant_without_seat'
        });
      }

      const slices = [
        {
          origin: from,
          destination: to,
          departure_date:
            departDate
        }
      ];

      if (returnDate) {
        slices.push({
          origin: to,
          destination: from,
          departure_date:
            returnDate
        });
      }

      const offerReqRes =
        await fetchWithTimeout(
          `${DUFFEL_BASE}/air/offer_requests?return_offers=true&supplier_timeout=10000`,
          {
            method: 'POST',

            headers:
              duffelHeaders(),

            body: JSON.stringify({
              data: {
                slices,
                passengers,
                cabin_class:
                  cabin,
              },
            }),
          }
        );

      if (!offerReqRes.ok) {
        console.error(
          'Duffel search error:',
          offerReqRes.status
        );

        return res.status(502).json({
          error:
            duffelErrorMessage(
              offerReqRes.status
            )
        });
      }

      const offerReqData =
        await offerReqRes.json();

      const offers =
        offerReqData.data?.offers ||
        [];

      const formatted =
        await formatDuffelResults(
          offers
        );

      return res.json({
        flights: formatted,
        count: formatted.length,
        currency: 'EGP'
      });

    } catch (err) {
      console.error(err);

      const status =
        err?.message?.includes(
          'انتهت مهلة'
        )
          ? 504
          : 500;

      return res.status(status).json({
        error:
          status === 504
            ? err.message
            : 'تعذر إكمال البحث حالياً. حاول مرة أخرى.'
      });
    }
  }
);

// ══════════════════════════════════════════════
// إعادة التحقق من العرض قبل تأكيد الطلب
// ══════════════════════════════════════════════

app.post(
  '/api/verify-offer',
  rateLimit,
  async (req, res) => {
    try {
      if (!DUFFEL_TOKEN) {
        return res.status(503).json({
          error:
            'خدمة التحقق غير مهيأة حالياً.'
        });
      }

      const offerId =
        String(
          req.body?.offerId || ''
        ).trim();

      if (
        !offerId ||
        offerId.length > 200 ||
        !/^off_[A-Za-z0-9_-]+$/.test(
          offerId
        )
      ) {
        return res.status(400).json({
          error:
            'معرّف الرحلة غير صالح.'
        });
      }

      const offerRes =
        await fetchWithTimeout(
          `${DUFFEL_BASE}/air/offers/${encodeURIComponent(offerId)}`,
          {
            method: 'GET',
            headers:
              duffelHeaders()
          }
        );

      if (!offerRes.ok) {
        console.error(
          'Duffel offer verification error:',
          offerRes.status,
          offerId
        );

        return res
          .status(
            offerRes.status === 404
              ? 409
              : 502
          )
          .json({
            error:
              offerRes.status === 404
                ? 'الرحلة لم تعد متاحة بنفس العرض. من فضلك أعد البحث للحصول على أحدث سعر.'
                : duffelErrorMessage(
                    offerRes.status
                  )
          });
      }

      const offerData =
        await offerRes.json();

      const offer =
        offerData.data;

      if (!offer) {
        return res.status(409).json({
          error:
            'تعذر العثور على أحدث بيانات الرحلة.'
        });
      }

      const formatted =
        await formatDuffelOffer(
          offer
        );

      return res.json({
        flight: formatted,
        verifiedAt:
          new Date().toISOString()
      });

    } catch (err) {
      console.error(err);

      const status =
        err?.message?.includes(
          'انتهت مهلة'
        )
          ? 504
          : 500;

      return res.status(status).json({
        error:
          status === 504
            ? err.message
            : 'تعذر التحقق من السعر حالياً. حاول مرة أخرى.'
      });
    }
  }
);

// ══════════════════════════════════════════════
// إرسال تفاصيل الحجز بالبريد الإلكتروني
// ══════════════════════════════════════════════

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function formatEmailPrice(value) {
  const n = Number(value);
  return Number.isFinite(n)
    ? `${Math.round(n).toLocaleString('en-US')} جنيه مصري`
    : 'غير متاح';
}

function formatEmailDate(value) {
  if (!value) return '—';
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return escapeHtml(value);
  const d = new Date(`${value}T12:00:00`);
  if (Number.isNaN(d.getTime())) return escapeHtml(value);
  return d.toLocaleDateString('ar-EG', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
}

function flightEmailHtml({ bookingRef, customer, flight, paymentMethods }) {
  const returnLeg = flight?.returnLeg;

  const paymentHtml = (Array.isArray(paymentMethods) && paymentMethods.length
    ? paymentMethods
    : ['Instapay', 'تحويل بنكي', 'Vodafone Cash', 'Fawry']
  ).map(method => `<li style="margin:0 0 8px">${escapeHtml(method)}</li>`).join('');

  const returnHtml = returnLeg ? `
    <tr>
      <td style="padding:10px 0;color:#667085">العودة</td>
      <td style="padding:10px 0;font-weight:700">
        ${escapeHtml(flight?.returnDate ? formatEmailDate(flight.returnDate) : '')}<br>${escapeHtml(returnLeg.from || '')} → ${escapeHtml(returnLeg.to || '')}
        &nbsp; ${escapeHtml(returnLeg.depTime || '')} - ${escapeHtml(returnLeg.arrTime || '')}
      </td>
    </tr>
  ` : '';

  return `
<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"></head>
<body style="margin:0;background:#f5f7fb;font-family:Arial,Tahoma,sans-serif;color:#172033">
  <div style="max-width:680px;margin:30px auto;padding:0 14px">
    <div style="background:#0a1a3f;border-radius:22px 22px 0 0;padding:26px;text-align:center;color:#fff">
      <div style="font-size:28px;font-weight:800">جوّك ✈️</div>
      <div style="margin-top:7px;font-size:14px;opacity:.85">تأكيد استلام طلب الحجز</div>
    </div>

    <div style="background:#fff;padding:28px;border-radius:0 0 22px 22px">
      <h2 style="margin:0 0 12px;font-size:21px">مرحباً ${escapeHtml(customer.name)}</h2>
      <p style="line-height:1.9;color:#475467;margin:0 0 22px">
        تم استلام طلب الحجز بنجاح. السعر الظاهر أمامك هو السعر النهائي للرحلة.
        فيما يلي تفاصيل الرحلة وطرق إتمام الحجز المتاحة.
      </p>

      <div style="background:#f8fafc;border:1px solid #e4e7ec;border-radius:16px;padding:18px;margin-bottom:18px">
        <div style="font-size:13px;color:#667085">رقم الطلب</div>
        <div style="font-size:20px;font-weight:800;margin-top:5px">${escapeHtml(bookingRef)}</div>
      </div>

      <div style="border:1px solid #e4e7ec;border-radius:16px;padding:18px;margin-bottom:18px">
        <h3 style="margin:0 0 12px">تفاصيل الرحلة</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr>
            <td style="padding:10px 0;color:#667085">شركة الطيران</td>
            <td style="padding:10px 0;font-weight:700">${escapeHtml(flight?.airlineName || 'شركة طيران')}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#667085">رقم الرحلة</td>
            <td style="padding:10px 0;font-weight:700">${escapeHtml(flight?.flightNumber || '')}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#667085">تاريخ الذهاب</td>
            <td style="padding:10px 0;font-weight:700">${formatEmailDate(flight?.departDate)}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#667085">الذهاب</td>
            <td style="padding:10px 0;font-weight:700">
              ${escapeHtml(flight?.from || '')} → ${escapeHtml(flight?.to || '')}
              &nbsp; ${escapeHtml(flight?.depTime || '')} - ${escapeHtml(flight?.arrTime || '')}
            </td>
          </tr>
          ${returnHtml}
          <tr>
            <td style="padding:10px 0;color:#667085">الدرجة</td>
            <td style="padding:10px 0;font-weight:700">${escapeHtml(flight?.cabin || 'اقتصادي')}</td>
          </tr>
        </table>
      </div>

      <div style="background:#eef6ff;border:1px solid #cfe2ff;border-radius:16px;padding:20px;margin-bottom:18px">
        <div style="font-size:13px;color:#475467">السعر النهائي للرحلة</div>
        <div style="font-size:27px;font-weight:900;margin-top:5px">${formatEmailPrice(flight?.price)}</div>
        <div style="font-size:12px;color:#667085;margin-top:6px">شامل الرسوم وفق السعر المعروض أثناء الحجز.</div>
      </div>

      <div style="border:1px solid #e4e7ec;border-radius:16px;padding:18px;margin-bottom:18px">
        <h3 style="margin:0 0 10px">طرق الحجز والدفع المتاحة</h3>
        <ul style="padding-right:22px;line-height:1.8;margin:8px 0">${paymentHtml}</ul>
        <p style="color:#667085;font-size:13px;line-height:1.8;margin:12px 0 0">
          للمتابعة، يمكنك الرد على هذا البريد الإلكتروني، وسيتابع فريق جوّك معك خطوات إتمام الحجز.
        </p>
      </div>

      <div style="color:#667085;font-size:13px;line-height:1.8">
        <strong>بيانات التواصل:</strong><br>
        الهاتف: ${escapeHtml(customer.phone)}<br>
        البريد الإلكتروني: ${escapeHtml(customer.email)}
      </div>

      <div style="border-top:1px solid #eaecf0;margin-top:24px;padding-top:18px;text-align:center;color:#98a2b3;font-size:12px">
        جوّك — رحلتك تبدأ من هنا ✈️
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function sendResendEmail({ to, subject, html, replyTo, idempotencyKey }) {
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    throw new Error(
      'خدمة البريد الإلكتروني غير مهيأة حالياً.'
    );
  }

  const body = {
    from: EMAIL_FROM,
    to: [to],
    subject,
    html,
  };

  if (replyTo) {
    body.reply_to = replyTo;
  }

  const response = await fetchWithTimeout(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    },
    15_000
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('Resend email error:', response.status, data);

    throw new Error(
      'تعذر إرسال البريد الإلكتروني حالياً.'
    );
  }

  return data;
}

app.post(
  '/api/send-booking-email',
  rateLimit,
  async (req, res) => {
    try {
      const bookingRef =
        String(req.body?.bookingRef || '').trim();

      const searchId =
        String(req.body?.searchId || '').trim();

      const customer =
        req.body?.customer || {};

      const customerName =
        String(customer.name || '').trim();

      const customerPhone =
        String(customer.phone || '').trim();

      const customerEmail =
        normalizeEmail(customer.email);

      const flight =
        req.body?.flight || {};

      const paymentMethods =
        Array.isArray(req.body?.paymentMethods)
          ? req.body.paymentMethods
          : ['Instapay', 'تحويل بنكي', 'Vodafone Cash', 'Fawry'];

      if (
        !bookingRef ||
        bookingRef.length > 100
      ) {
        return res.status(400).json({
          error: 'رقم الطلب غير صالح.'
        });
      }

      if (
        !customerName ||
        customerName.length > 150
      ) {
        return res.status(400).json({
          error: 'اسم العميل غير صالح.'
        });
      }

      if (
        !customerPhone ||
        customerPhone.length > 50
      ) {
        return res.status(400).json({
          error: 'رقم الهاتف غير صالح.'
        });
      }

      if (
        !customerEmail ||
        customerEmail.length > 200 ||
        !validEmail(customerEmail)
      ) {
        return res.status(400).json({
          error: 'البريد الإلكتروني غير صالح.'
        });
      }

      if (
        !flight?.id ||
        !flight?.airlineName ||
        !flight?.from ||
        !flight?.to
      ) {
        return res.status(400).json({
          error: 'بيانات الرحلة غير مكتملة.'
        });
      }

      if (
        !Number.isFinite(Number(flight.price)) ||
        Number(flight.price) < 0
      ) {
        return res.status(400).json({
          error: 'سعر الرحلة غير صالح.'
        });
      }

      const emailData = {
        bookingRef,
        searchId,
        customer: {
          name: customerName,
          phone: customerPhone,
          email: customerEmail,
        },
        flight,
        paymentMethods,
      };

      const customerHtml =
        flightEmailHtml(emailData);

      const subject =
        `جوّك — تفاصيل طلب الحجز ${bookingRef}`;

      const result =
        await sendResendEmail({
          to: customerEmail,
          subject,
          html: customerHtml,
          replyTo: EMAIL_REPLY_TO || undefined,
          idempotencyKey: `jawwak-booking-${bookingRef}`,
        });

      // يتم إرسال إيميل واحد فقط إلى العميل.

      return res.json({
        ok: true,
        bookingRef,
        emailId: result?.id || null,
        sentTo: customerEmail,
      });

    } catch (err) {
      console.error(err);

      return res.status(500).json({
        error:
          err?.message ||
          'تعذر إرسال تفاصيل الحجز بالبريد الإلكتروني حالياً.'
      });
    }
  }
);

// ══════════════════════════════════════════════
// متابعة حالة الحجز + لوحة الإدارة
// ══════════════════════════════════════════════

const BOOKING_STATUS_LABELS = {
  pending: '🟡 جاري تأكيد الحجز',
  awaiting_payment: '🟠 في انتظار الدفع',
  payment_sent: '🔵 تم إرسال بيانات الدفع',
  confirmed: '🟢 تم تأكيد الحجز',
  failed: '🔴 تعذر إتمام الحجز',
  cancelled: '🔴 تعذر إتمام الحجز'
};

const BOOKING_STATUSES = new Set([
  'pending',
  'awaiting_payment',
  'payment_sent',
  'confirmed',
  'failed',
  'cancelled'
]);

const BOOKING_REF_RE = /^JWK-[A-Z0-9-]{4,100}$/i;

function normalizeBookingRef(value) {
  return String(value || '').trim().toUpperCase();
}

function isAdminPasswordValid(req) {
  const supplied = String(req.headers['x-admin-password'] || '');
  return Boolean(ADMIN_PASSWORD && supplied && supplied === ADMIN_PASSWORD);
}

async function supabaseRest(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase status service is not configured.');
  }

  return fetchWithTimeout(
    `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {})
      }
    },
    10_000
  );
}

app.get('/api/booking-status', rateLimit, async (req, res) => {
  try {
    const bookingRef = normalizeBookingRef(req.query?.bookingRef);

    if (!BOOKING_REF_RE.test(bookingRef)) {
      return res.status(400).json({ error: 'رقم الحجز غير صالح.' });
    }

    const response = await supabaseRest(
      `bookings?select=booking_ref,status&booking_ref=eq.${encodeURIComponent(bookingRef)}&limit=1`,
      { method: 'GET' }
    );

    const data = await response.json().catch(() => []);

    if (!response.ok) {
      console.error('Booking status read error:', response.status, data);
      return res.status(502).json({ error: 'تعذر قراءة حالة الحجز حالياً.' });
    }

    const booking = Array.isArray(data) ? data[0] : null;

    if (!booking) {
      return res.status(404).json({ error: 'لم يتم العثور على حجز بهذا الرقم.' });
    }

    const status = BOOKING_STATUSES.has(String(booking.status || ''))
      ? String(booking.status)
      : 'pending';

    return res.json({
      bookingRef: booking.booking_ref,
      status,
      label: BOOKING_STATUS_LABELS[status] || BOOKING_STATUS_LABELS.pending
    });
  } catch (err) {
    console.error('Booking status error:', err);
    return res.status(500).json({ error: 'تعذر التحقق من حالة الحجز حالياً.' });
  }
});

app.post('/api/admin/verify', rateLimit, async (req, res) => {
  if (!isAdminPasswordValid(req)) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
  }
  return res.json({ ok: true });
});

app.get('/api/admin/bookings', rateLimit, async (req, res) => {
  try {
    if (!isAdminPasswordValid(req)) {
      return res.status(401).json({ error: 'غير مصرح.' });
    }

    const response = await supabaseRest(
      'bookings?select=*&order=created_at.desc',
      { method: 'GET' }
    );
    const data = await response.json().catch(() => []);

    if (!response.ok) {
      console.error('Admin bookings read error:', response.status, data);
      return res.status(502).json({ error: 'تعذر تحميل الحجوزات من قاعدة البيانات.' });
    }

    return res.json({ bookings: Array.isArray(data) ? data : [] });
  } catch (err) {
    console.error('Admin bookings error:', err);
    return res.status(500).json({ error: 'تعذر تحميل الحجوزات حالياً.' });
  }
});

app.get('/api/admin/contacts', rateLimit, async (req, res) => {
  try {
    if (!isAdminPasswordValid(req)) {
      return res.status(401).json({ error: 'غير مصرح.' });
    }

    const response = await supabaseRest(
      'contact_requests?select=*&order=created_at.desc',
      { method: 'GET' }
    );
    const data = await response.json().catch(() => []);

    if (!response.ok) {
      console.error('Admin contacts read error:', response.status, data);
      return res.status(502).json({ error: 'تعذر تحميل طلبات التواصل.' });
    }

    return res.json({ contacts: Array.isArray(data) ? data : [] });
  } catch (err) {
    console.error('Admin contacts error:', err);
    return res.status(500).json({ error: 'تعذر تحميل طلبات التواصل حالياً.' });
  }
});

app.post('/api/admin/booking-status', rateLimit, async (req, res) => {
  try {
    if (!isAdminPasswordValid(req)) {
      return res.status(401).json({ error: 'غير مصرح.' });
    }

    const bookingRef = normalizeBookingRef(req.body?.bookingRef);
    const status = String(req.body?.status || '').trim().toLowerCase();

    if (!BOOKING_REF_RE.test(bookingRef)) {
      return res.status(400).json({ error: 'رقم الحجز غير صالح.' });
    }

    if (!BOOKING_STATUSES.has(status)) {
      return res.status(400).json({ error: 'حالة الحجز غير صالحة.' });
    }

    const response = await supabaseRest(
      `bookings?booking_ref=eq.${encodeURIComponent(bookingRef)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status })
      }
    );

    const data = await response.json().catch(() => []);

    if (!response.ok) {
      console.error('Admin booking status update error:', response.status, data);
      return res.status(502).json({ error: 'تعذر تحديث حالة الحجز في قاعدة البيانات.' });
    }

    if (!Array.isArray(data) || !data.length) {
      return res.status(404).json({ error: 'لم يتم العثور على حجز بهذا الرقم.' });
    }

    return res.json({
      ok: true,
      bookingRef,
      status,
      label: BOOKING_STATUS_LABELS[status]
    });
  } catch (err) {
    console.error('Admin booking status error:', err);
    return res.status(500).json({ error: 'تعذر تحديث حالة الحجز حالياً.' });
  }
});

// ══════════════════════════════════════════════
// Health Check
// ══════════════════════════════════════════════

app.get(
  '/api/health',
  async (req, res) => {
    let ratesOk = false;
    let egpRate = null;

    try {
      const rates =
        await getExchangeRates();

      egpRate =
        Number(rates.egp) || null;

      ratesOk =
        Boolean(egpRate);

    } catch (_) {}

    res.json({
      status: 'ok',

      duffelConfigured:
        Boolean(DUFFEL_TOKEN),

      emailConfigured:
        Boolean(
          RESEND_API_KEY &&
          EMAIL_FROM
        ),

      mode:
        DUFFEL_TOKEN?.startsWith(
          'duffel_test_'
        )
          ? 'test'
          : (
              DUFFEL_TOKEN
                ? 'live'
                : 'not-configured'
            ),

      currencyConversion:
        ratesOk
          ? 'ok'
          : 'unavailable',

      usdToEgpRate:
        egpRate,
    });
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `✅ سيرفر جوّك شغال على port ${PORT}`
    );

    console.log(
      '   مصدر البيانات: Duffel API'
    );

    console.log(
      '   الأسعار بتترجع بالجنيه المصري EGP'
    );

    console.log(
      '   Verify Offer مفعّل قبل تأكيد السعر'
    );

    console.log(
      `   Email service: ${RESEND_API_KEY && EMAIL_FROM ? 'configured' : 'not configured'}`
    );
  }
);
