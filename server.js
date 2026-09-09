// ══════════════════════════════════════════════
// سيرفر جوّك الخلفي — Launch Ready
// Duffel + تحويل عملة إلى EGP + تحقق من السعر قبل تأكيد الطلب
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

// حد زمني لحماية السيرفر من الطلبات المعلقة.
const DUFFEL_TIMEOUT_MS = 20_000;
const FX_TIMEOUT_MS = 10_000;

// التسعير
const CURRENCY_FEE_PERCENT = 3;
const PROFIT_MARGIN_PERCENT = 5;
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

app.use(cors({
  origin(origin, callback) {
    // الطلبات بدون Origin (مثل health checks) مسموحة.
    if (!origin) return callback(null, true);
    if (!FRONTEND_URL) return callback(null, true);
    const allowed = FRONTEND_URL.split(',').map(v => v.trim()).filter(Boolean);
    return callback(null, allowed.includes(origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
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

  // منع نمو الـMap بلا حدود.
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
        firstSegment.arriving_at || ''
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

    // لا نخترع رقم مقاعد إذا Duffel لم توفره.
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
// إعادة التحقق من العرض قبل إرسال العميل لواتساب
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
  }
);