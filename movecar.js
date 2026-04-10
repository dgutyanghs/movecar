addEventListener('fetch', event => {
  event.respondWith(handleRequest(event))
})

const CONFIG = { KV_TTL: 7200 }
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

function generateMapUrls(lat, lng) {
  const gcj = wgs84ToGcj02(lat, lng);
  return {
    amapUrl: `https://uri.amap.com/marker?position=${gcj.lng},${gcj.lat}&name=Location`,
    appleUrl: `https://maps.apple.com/?ll=${gcj.lat},${gcj.lng}&q=Location`
  };
}

async function handleRequest(event) {
  const request = event.request;
  const url = new URL(request.url)
  const path = url.pathname
  const query = url.searchParams

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }
  if (path.startsWith('/api/') && request.method === 'POST') {
    return handleApiPost(event, path, request);
  }
  if (path === '/api/check-status') {
    return handleCheckStatus(query);
  }
  if (path === '/api/get-location') {
    return handleGetLocation(query);
  }
  if (path === '/donnie') {
    return renderDonniePage();
  }
  if (path === '/' || path === '/index.html') {
    return renderCustomerPage(query);
  }
  return new Response('Not Found', { status: 404 });
}

async function handleApiPost(event, path, request) {
  switch (path) {
    case '/api/order-notify': return handleOrderNotify(event, request);
    case '/api/resend-notify': return handleResendNotify(event, request);
    case '/api/customer-location': return handleCustomerLocation(request);
    case '/api/owner-confirm': return handleOwnerConfirm(request);
    case '/api/order-update': return handleOrderUpdate(request);
    default: return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
}

async function handleOrderNotify(event, request) {
  try {
    const body = await request.json();
    const { orderNumber, orderSummary, notes, phone } = body;
    if (!orderNumber || !orderSummary) {
      return new Response(JSON.stringify({ success: false, error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }
    const orderData = JSON.stringify({
      orderNumber,
      orderSummary,
      notes: notes || '',
      phone: phone || '',
      createdAt: new Date().toISOString()
    });
    await MOVE_CAR_STATUS.put(`order_${orderNumber}_data`, orderData, { expirationTtl: 86400 });
    await MOVE_CAR_STATUS.put(`order_${orderNumber}_status`, 'waiting');
    const response = new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
    const barkUrl = BARK_URL || 'https://api.day.app/eFGndj54yypJJ6U6mGx32G';
    const confirmUrl = `https://orders.ciqikou.cc/donnie?order=${orderNumber}`;
    event.waitUntil(fetch(`${barkUrl}/${orderNumber}/New%20order:%20${encodeURIComponent(orderSummary)}?url=${encodeURIComponent(confirmUrl)}`));
    return response;
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}

async function handleResendNotify(event, request) {
  try {
    const body = await request.json();
    const { orderNumber } = body;
    if (!orderNumber) {
      return new Response(JSON.stringify({ success: false, error: 'Missing orderNumber' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }
    const orderDataStr = await MOVE_CAR_STATUS.get(`order_${orderNumber}_data`);
    if (!orderDataStr) {
      return new Response(JSON.stringify({ success: false, error: 'Order not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }
    const orderData = JSON.parse(orderDataStr);
    const barkUrl = BARK_URL || 'https://api.day.app/eFGndj54yypJJ6U6mGx32G';

    const confirmUrl = `https://orders.ciqikou.cc/donnie?order=${orderNumber}`;
    event.waitUntil(fetch(`${barkUrl}/${orderNumber}/Reminder:%20${encodeURIComponent(orderData.orderSummary)}?url=${encodeURIComponent(confirmUrl)}`));
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}

async function handleCustomerLocation(request) {
  try {
    const body = await request.json();
    const { orderNumber, lat, lng } = body;
    if (!orderNumber || !lat || !lng) {
      return new Response(JSON.stringify({ success: false, error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }
    const urls = generateMapUrls(lat, lng);
    const locationData = JSON.stringify({ lat, lng, ...urls, timestamp: Date.now() });
    await MOVE_CAR_STATUS.put(`order_${orderNumber}_customer_location`, locationData, { expirationTtl: CONFIG.KV_TTL });
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}

async function handleOwnerConfirm(request) {
  try {
    const body = await request.json();
    const { orderNumber, lat, lng } = body;
    if (!orderNumber) {
      return new Response(JSON.stringify({ success: false, error: 'Missing orderNumber' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    await MOVE_CAR_STATUS.put(`order_${orderNumber}_status`, 'confirmed');
    if (lat && lng) {
      const urls = generateMapUrls(lat, lng);
      const locationData = JSON.stringify({ lat, lng, ...urls, timestamp: Date.now() });
      await MOVE_CAR_STATUS.put(`order_${orderNumber}_donnie_location`, locationData, { expirationTtl: CONFIG.KV_TTL });
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}

async function handleOrderUpdate(request) {
  try {
    const body = await request.json();
    const { orderNumber, status } = body;
    if (!orderNumber || !status) {
      return new Response(JSON.stringify({ success: false, error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }
    await MOVE_CAR_STATUS.put(`order_${orderNumber}_status`, status);
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}

async function handleCheckStatus(query) {
  const orderNumber = query.get('order');
  if (!orderNumber) {
    return new Response(JSON.stringify({ error: 'Missing order parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
  const status = await MOVE_CAR_STATUS.get(`order_${orderNumber}_status`);
  const donnieLocation = await MOVE_CAR_STATUS.get(`order_${orderNumber}_donnie_location`);
  const customerLocation = await MOVE_CAR_STATUS.get(`order_${orderNumber}_customer_location`);
  return new Response(JSON.stringify({
    status: status || 'not_found',
    donnieLocation: donnieLocation ? JSON.parse(donnieLocation) : null,
    customerLocation: customerLocation ? JSON.parse(customerLocation) : null
  }), {
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

async function handleGetLocation(query) {
  const orderNumber = query.get('order');
  const type = query.get('type') || 'donnie';
  if (!orderNumber) {
    return new Response(JSON.stringify({ error: 'Missing order parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
  const key = type === 'customer' ? `order_${orderNumber}_customer_location` : `order_${orderNumber}_donnie_location`;
  const data = await MOVE_CAR_STATUS.get(key);
  if (data) {
    return new Response(data, { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
  return new Response(JSON.stringify({ error: 'No location found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

function renderCustomerPage(query) {
  const orderNumber = query.get('order') || '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Order Tracking - ${orderNumber}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%); min-height: 100vh; padding: 20px; }
    .container { max-width: 500px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
    .card { background: rgba(255,255,255,0.95); border-radius: 20px; padding: 24px; box-shadow: 0 10px 40px rgba(0,147,233,0.2); }
    .header { text-align: center; }
    .icon-wrap { width: 80px; height: 80px; background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%); border-radius: 24px; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-size: 40px; }
    h1 { font-size: 24px; color: #1a202c; margin-bottom: 8px; }
    .subtitle { color: #718096; }
    .status-card { text-align: center; }
    .status-badge { display: inline-block; padding: 8px 24px; border-radius: 20px; font-size: 16px; font-weight: 700; margin-bottom: 16px; }
    .waiting { background: #fef3c7; color: #92400e; }
    .confirmed { background: #d1fae5; color: #065f46; }
    .delivered { background: #dbeafe; color: #1e40af; }
    .order-info { background: #f7fafc; border-radius: 12px; padding: 16px; margin-bottom: 16px; text-align: left; }
    .order-info p { font-size: 14px; color: #4a5568; margin-bottom: 8px; }
    .order-info p:last-child { margin-bottom: 0; }
    .loc-card { display: flex; align-items: center; gap: 16px; cursor: pointer; min-height: 64px; }
    .loc-icon { width: 48px; height: 48px; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-size: 24px; }
    .loading { background: #fff3cd; }
    .success { background: #d4edda; }
    .loc-title { font-size: 16px; font-weight: 600; color: #2d3748; }
    .loc-status { font-size: 13px; color: #718096; margin-top: 4px; }
    .loc-status.success { color: #28a745; }
    .btn-main { background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%); color: white; border: none; padding: 18px; border-radius: 16px; font-size: 16px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; box-shadow: 0 10px 30px rgba(0,147,233,0.35); transition: all 0.2s; min-height: 56px; }
    .btn-main:active { transform: scale(0.98); }
    .btn-main:disabled { background: linear-gradient(135deg, #94a3b8 0%, #64748b 100%); box-shadow: none; cursor: not-allowed; }
    .btn-main.shared { background: linear-gradient(135deg, #10b981 0%, #059669 100%); }
    .toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%) translateY(-100px); background: white; padding: 12px 24px; border-radius: 16px; font-size: 14px; font-weight: 600; color: #2d3748; box-shadow: 0 10px 40px rgba(0,0,0,0.15); opacity: 0; transition: all 0.4s; z-index: 100; }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .map-links { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
    .map-btn { flex: 1; min-width: 120px; padding: 12px; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 14px; text-align: center; min-height: 48px; display: flex; align-items: center; justify-content: center; }
    .amap { background: #1890ff; color: white; }
    .apple { background: #1d1d1f; color: white; }
    .delivery-card { background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%); border: 2px solid #10b981; }
    .delivery-card h3 { color: #065f46; margin-bottom: 12px; font-size: 16px; }
    .delivery-card p { color: #047857; font-size: 14px; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .loading-text { animation: pulse 1.5s ease-in-out infinite; }
  </style>
</head>
<body>
  <div id="toast" class="toast"></div>
  <div class="container">
    <div class="card header">
      <div class="icon-wrap">📦</div>
      <h1>Order #${orderNumber}</h1>
      <p class="subtitle">Track Your Delivery</p>
    </div>
    <div class="card status-card">
      <span id="statusBadge" class="status-badge waiting loading-text">Waiting for Donnie...</span>
      <div class="order-info">
        <p><strong>Order:</strong> <span id="orderSummary">Loading...</span></p>
      </div>
    </div>
    <div class="card loc-card">
      <div id="customerLocIcon" class="loc-icon loading">📍</div>
      <div class="loc-content">
        <div class="loc-title">Share My Location</div>
        <div id="customerLocStatus" class="loc-status">Tap to share your location for delivery</div>
      </div>
    </div>
    <button id="shareLocationBtn" class="card btn-main" onclick="shareCustomerLocation()">
      <span>📍</span><span>Share My Location</span>
    </button>
    <button id="resendNotifyBtn" class="card btn-main" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);" onclick="resendNotify()">
      <span>🔔</span><span>Remind Donnie</span>
    </button>
    <div id="donnieLocationCard" class="card delivery-card" style="display: none;">
      <h3>🎉 Donnie is on the way!</h3>
      <p>Track Donnie's location in real-time:</p>
      <div class="map-links">
        <a id="donnieAmapLink" href="#" class="map-btn amap" target="_blank">Gaode Maps</a>
        <a id="donnieAppleLink" href="#" class="map-btn apple" target="_blank">Apple Maps</a>
      </div>
    </div>
  </div>
  <script>
    const orderNumber = '${orderNumber}';
    let customerLocation = null;
    let donnieLocation = null;
    let currentStatus = 'waiting';
    async function loadOrderInfo() {
      try {
        const res = await fetch(\`/api/check-status?order=${orderNumber}\`);
        const data = await res.json();
        currentStatus = data.status;
        updateStatusBadge(data.status);
        if (data.donnieLocation) { donnieLocation = data.donnieLocation; showDonnieLocation(); }
      } catch(e) { console.error('Error loading status:', e); }
    }
    function updateStatusBadge(status) {
      const badge = document.getElementById('statusBadge');
      badge.className = 'status-badge';
      if (status === 'waiting') { badge.classList.add('waiting'); badge.textContent = 'Waiting for Donnie...'; }
      else if (status === 'confirmed') { badge.classList.remove('loading-text'); badge.classList.add('confirmed'); badge.textContent = 'Donnie is on the way!'; }
      else if (status === 'delivered') { badge.classList.remove('loading-text'); badge.classList.add('delivered'); badge.textContent = 'Delivered!'; }
    }
    function showDonnieLocation() {
      if (!donnieLocation) return;
      document.getElementById('donnieLocationCard').style.display = 'block';
      if (donnieLocation.amapUrl) {
        document.getElementById('donnieAmapLink').href = donnieLocation.amapUrl;
        document.getElementById('donnieAppleLink').href = donnieLocation.appleUrl;
      }
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
    async function shareCustomerLocation() {
      const btn = document.getElementById('shareLocationBtn');
      const icon = document.getElementById('customerLocIcon');
      const status = document.getElementById('customerLocStatus');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span><span>Getting location...</span>';
      if (!('geolocation' in navigator)) { showToast('Geolocation not supported'); btn.disabled = false; return; }
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          customerLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          try {
            await fetch('/api/customer-location', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderNumber, ...customerLocation }) });
            icon.className = 'loc-icon success'; icon.textContent = '✓';
            status.className = 'loc-status success'; status.textContent = 'Location shared!';
            btn.classList.add('shared'); btn.innerHTML = '<span>✓</span><span>Location Shared</span>'; btn.disabled = true;
            showToast('Location shared with Donnie!');
          } catch(e) { showToast('Failed to share location'); btn.disabled = false; btn.innerHTML = '<span>📍</span><span>Share My Location</span>'; }
        },
        (err) => { showToast('Failed to get location'); btn.disabled = false; btn.innerHTML = '<span>📍</span><span>Share My Location</span>'; },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    }
    async function resendNotify() {
      const btn = document.getElementById('resendNotifyBtn');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span><span>Sending...</span>';
      try {
        const res = await fetch('/api/resend-notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderNumber }) });
        const data = await res.json();
        if (data.success) {
          showToast('Reminder sent to Donnie!');
          btn.innerHTML = '<span>✓</span><span>Reminder Sent</span>';
        } else {
          showToast('Failed to send reminder');
          btn.disabled = false;
          btn.innerHTML = '<span>🔔</span><span>Remind Donnie</span>';
        }
      } catch(e) { showToast('Failed to send reminder'); btn.disabled = false; btn.innerHTML = '<span>🔔</span><span>Remind Donnie</span>'; }
    }
    function showToast(text) { const t = document.getElementById('toast'); t.innerText = text; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3000); }
    setInterval(async () => {
      try {
        const res = await fetch(\`/api/check-status?order=${orderNumber}\`);
        const data = await res.json();
        if (data.status !== currentStatus) { currentStatus = data.status; updateStatusBadge(data.status); }
        if (data.donnieLocation && !donnieLocation) { donnieLocation = data.donnieLocation; showDonnieLocation(); }
      } catch(e) {}
    }, 3000);
    loadOrderInfo();
  </script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function renderDonniePage() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Donnie - Order Management</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: linear-gradient(160deg, #10b981 0%, #059669 100%); min-height: 100vh; padding: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .card { background: rgba(255,255,255,0.95); padding: 32px; border-radius: 24px; text-align: center; width: 100%; max-width: 420px; box-shadow: 0 20px 60px rgba(16,185,129,0.3); }
    .emoji { font-size: 64px; margin-bottom: 16px; display: block; }
    h1 { font-size: 24px; color: #2d3748; margin-bottom: 8px; }
    .subtitle { color: #718096; font-size: 14px; margin-bottom: 24px; }
    .order-section { background: #f7fafc; border-radius: 12px; padding: 16px; margin-bottom: 20px; text-align: left; }
    .order-section p { font-size: 14px; color: #4a5568; margin-bottom: 8px; }
    .order-section p strong { color: #2d3748; }
    .input-group { margin-bottom: 16px; text-align: left; }
    .input-group label { display: block; font-size: 13px; color: #4a5568; margin-bottom: 8px; font-weight: 600; }
    .input-group input { width: 100%; padding: 14px; border: 2px solid #e2e8f0; border-radius: 12px; font-size: 16px; outline: none; transition: border-color 0.2s; }
    .input-group input:focus { border-color: #10b981; }
    .loc-card { background: #fef3c7; border-radius: 12px; padding: 16px; margin-bottom: 20px; display: flex; align-items: center; gap: 12px; }
    .loc-icon { font-size: 28px; }
    .loc-text { flex: 1; text-align: left; }
    .loc-text p { font-size: 14px; color: #92400e; margin: 0; }
    .btn { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; width: 100%; padding: 16px; border-radius: 14px; font-size: 16px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; box-shadow: 0 8px 24px rgba(16,185,129,0.35); transition: all 0.2s; min-height: 56px; margin-bottom: 12px; }
    .btn:active { transform: scale(0.98); }
    .btn:disabled { background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%); box-shadow: none; cursor: not-allowed; }
    .btn-secondary { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); box-shadow: 0 8px 24px rgba(239,68,68,0.3); }
    .done-msg { background: linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%); border-radius: 12px; padding: 16px; margin-top: 16px; display: none; }
    .done-msg.show { display: block; }
    .done-msg p { color: #065f46; font-weight: 600; font-size: 15px; }
    .toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%) translateY(-100px); background: white; padding: 12px 24px; border-radius: 16px; font-size: 14px; font-weight: 600; color: #2d3748; box-shadow: 0 10px 40px rgba(0,0,0,0.15); opacity: 0; transition: all 0.4s; z-index: 100; }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  </style>
</head>
<body>
  <div id="toast" class="toast"></div>
  <div class="card">
    <span class="emoji">👋</span>
    <h1>Order Management</h1>
    <p class="subtitle">Manage your delivery orders</p>
    <div class="order-section">
      <p><strong>Order Number:</strong></p>
      <div class="input-group">
        <input type="text" id="orderNumber" placeholder="Enter order number (e.g., A001)">
      </div>
      <p><strong>Customer Notes:</strong></p>
      <div class="input-group">
        <input type="text" id="customerNotes" placeholder="Notes from customer">
      </div>
    </div>
    <div id="customerLocationCard" class="loc-card" style="display: none;">
      <span class="loc-icon">📍</span>
      <div class="loc-text">
        <p>Customer Location</p>
        <div style="margin-top: 8px;">
          <a id="customerAmapLink" href="#" target="_blank" style="display:inline-block;padding:8px 12px;font-size:13px;border-radius:8px;background:#1890ff;color:white;text-decoration:none;margin-right:8px;">Gaode</a>
          <a id="customerAppleLink" href="#" target="_blank" style="display:inline-block;padding:8px 12px;font-size:13px;border-radius:8px;background:#1d1d1f;color:white;text-decoration:none;">Apple</a>
        </div>
      </div>
    </div>
    <button id="onTheWayBtn" class="btn" onclick="startDelivery()">
      <span>🚴</span><span>On my way</span>
    </button>
    <button id="deliveredBtn" class="btn btn-secondary" onclick="markDelivered()">
      <span>✅</span><span>Delivered</span>
    </button>
    <div id="doneMsg" class="done-msg">
      <p id="doneText">Status updated!</p>
    </div>
  </div>
  <script>
    let donnyLocation = null;
    let currentOrderNumber = null;
    async function loadCustomerLocation() {
      const orderNumber = document.getElementById('orderNumber').value.trim();
      if (!orderNumber) return;
      currentOrderNumber = orderNumber;
      try {
        const res = await fetch(\`/api/get-location?order=\${orderNumber}&type=customer\`);
        if (res.ok) {
          const data = await res.json();
          document.getElementById('customerLocationCard').style.display = 'flex';
          document.getElementById('customerAmapLink').href = data.amapUrl || '#';
          document.getElementById('customerAppleLink').href = data.appleUrl || '#';
        }
      } catch(e) {}
    }
    async function startDelivery() {
      const orderNumber = document.getElementById('orderNumber').value.trim();
      if (!orderNumber) { showToast('Please enter order number'); return; }
      const btn = document.getElementById('onTheWayBtn');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span><span>Getting location...</span>';
      if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
          async (pos) => { donnyLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; await confirmDelivery(orderNumber, 'confirmed'); },
          async (err) => { await confirmDelivery(orderNumber, 'confirmed'); },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
      } else { await confirmDelivery(orderNumber, 'confirmed'); }
    }
    async function confirmDelivery(orderNumber, status) {
      const btn = document.getElementById('onTheWayBtn');
      try {
        const body = { orderNumber, status };
        if (donnyLocation) { body.lat = donnyLocation.lat; body.lng = donnyLocation.lng; }
        await fetch('/api/owner-confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        btn.innerHTML = '<span>✅</span><span>Confirmed</span>';
        btn.style.background = 'linear-gradient(135deg, #9ca3af 0%, #6b7280 100%)';
        document.getElementById('doneMsg').classList.add('show');
        document.getElementById('doneText').textContent = 'Customer can now see your location!';
      } catch(e) { btn.disabled = false; btn.innerHTML = '<span>🚴</span><span>On the way</span>'; showToast('Failed to confirm'); }
    }
    async function markDelivered() {
      const orderNumber = document.getElementById('orderNumber').value.trim();
      if (!orderNumber) { showToast('Please enter order number'); return; }
      const btn = document.getElementById('deliveredBtn');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span><span>Updating...</span>';
      try {
        await fetch('/api/order-update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderNumber, status: 'delivered' }) });
        btn.innerHTML = '<span>✅</span><span>Delivered</span>';
        document.getElementById('doneMsg').classList.add('show');
        document.getElementById('doneText').textContent = 'Order marked as delivered!';
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      } catch(e) { btn.disabled = false; btn.innerHTML = '<span>✅</span><span>Delivered</span>'; showToast('Failed to update'); }
    }
    function showToast(text) { const t = document.getElementById('toast'); t.innerText = text; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3000); }
    let debounceTimer;
    document.getElementById('orderNumber').addEventListener('input', () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(loadCustomerLocation, 500); });
  </script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}