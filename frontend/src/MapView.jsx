// frontend/src/MapView.jsx
import { useEffect, useRef, useState } from 'react';
import { loadAmapScript, isAmapLoaded } from './mapLoader.js';

const TYPE_ICON = {
  hotel: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_b.png',
  restaurant: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
  scenic: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_g.png',
  activity: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_p.png',
  other: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_q.png',
};

function resolveType(type) {
  if (!type) return 'other';
  const raw = String(type).trim();
  const lowered = raw.toLowerCase();
  if (
    lowered.includes('hotel') ||
    lowered.includes('stay') ||
    lowered.includes('accommodation') ||
    raw.includes('酒店') ||
    raw.includes('住宿')
  ) {
    return 'hotel';
  }
  if (
    lowered.includes('restaurant') ||
    lowered.includes('food') ||
    lowered.includes('dining') ||
    lowered.includes('meal') ||
    raw.includes('餐') ||
    raw.includes('美食')
  ) {
    return 'restaurant';
  }
  if (
    lowered.includes('scenic') ||
    lowered.includes('sight') ||
    lowered.includes('attraction') ||
    lowered.includes('viewpoint') ||
    raw.includes('景点') ||
    raw.includes('景区') ||
    raw.includes('景观')
  ) {
    return 'scenic';
  }
  if (
    lowered.includes('activity') ||
    lowered.includes('event') ||
    lowered.includes('experience') ||
    raw.includes('活动') ||
    raw.includes('体验')
  ) {
    return 'activity';
  }
  return 'other';
}

function getIcon(type) {
  const resolved = resolveType(type);
  return TYPE_ICON[resolved] || TYPE_ICON.other;
}

function createInfoWindowContent(point) {
  const segments = [];
  segments.push(`<div style="font-weight:600;font-size:14px;color:#0f172a;margin-bottom:6px;">${point.name}</div>`);
  if (point.dayTitle) {
    segments.push(`<div style="font-size:12px;color:#64748b;margin-bottom:4px;">${point.dayTitle}</div>`);
  }
  if (point.time) {
    segments.push(`<div style="font-size:12px;color:#475569;margin-bottom:4px;">时间：${point.time}</div>`);
  }
  if (point.address) {
    segments.push(`<div style="font-size:12px;color:#475569;margin-bottom:4px;">地址：${point.address}</div>`);
  }
  if (point.description) {
    segments.push(`<div style="font-size:12px;color:#475569;margin-bottom:4px;line-height:1.5;">${point.description}</div>`);
  }
  if (point.budget != null) {
    segments.push(`<div style="font-size:12px;color:#0f766e;">预算：${point.budget}</div>`);
  }
  return `<div style="min-width:220px;">${segments.join('')}</div>`;
}

function MapView({ points = [], focusPointId = null, onMarkerClick }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const polylineRef = useRef(null);
  const infoWindowRef = useRef(null);
  const [amapReady, setAmapReady] = useState(isAmapLoaded());
  const [error, setError] = useState(null);

  useEffect(() => {
    if (amapReady) return;
    loadAmapScript()
      .then(() => {
        setAmapReady(true);
        setError(null);
      })
      .catch((err) => {
        setError(err.message || '地图加载失败');
      });
  }, [amapReady]);

  useEffect(() => {
    if (!amapReady || !containerRef.current || !window.AMap) return;
    if (!mapRef.current) {
      mapRef.current = new window.AMap.Map(containerRef.current, {
        zoom: 11,
        viewMode: '2D',
        resizeEnable: true,
      });
    }
    if (!infoWindowRef.current) {
      infoWindowRef.current = new window.AMap.InfoWindow({
        offset: new window.AMap.Pixel(0, -24),
      });
    }
  }, [amapReady]);

  useEffect(() => {
    if (!mapRef.current || !window.AMap) return;
    // 清理旧标记
    markersRef.current.forEach((marker) => marker.setMap(null));
    markersRef.current = [];
    if (polylineRef.current) {
      polylineRef.current.setMap(null);
      polylineRef.current = null;
    }
    if (!points.length) return;

    const validPoints = points.filter(
      (p) => typeof p.longitude === 'number' && typeof p.latitude === 'number'
    );
    const map = mapRef.current;
    const bounds = new window.AMap.Bounds();
    validPoints.forEach((point) => {
      const position = new window.AMap.LngLat(point.longitude, point.latitude);
      const marker = new window.AMap.Marker({
        position,
        title: point.name,
        icon: new window.AMap.Icon({
          size: new window.AMap.Size(24, 30),
          image: getIcon(point.type),
          imageSize: new window.AMap.Size(24, 30),
        }),
        extData: point,
        offset: new window.AMap.Pixel(-12, -30),
      });
      marker.on('click', () => {
        if (infoWindowRef.current) {
          infoWindowRef.current.setContent(createInfoWindowContent(point));
          infoWindowRef.current.open(map, position);
        }
        if (typeof onMarkerClick === 'function') {
          onMarkerClick(point);
        }
      });
      marker.setMap(map);
      markersRef.current.push(marker);
      bounds.extend(position);
    });

    if (markersRef.current.length > 0) {
      map.setFitView(markersRef.current, false, [40, 40, 40, 40]);
    }

    if (validPoints.length > 1) {
      const path = validPoints.map((point) => [point.longitude, point.latitude]);
      polylineRef.current = new window.AMap.Polyline({
        path,
        strokeWeight: 6,
        strokeColor: '#2563eb',
        strokeOpacity: 0.9,
        showDir: true,
      });
      polylineRef.current.setMap(map);
    }
  }, [points, onMarkerClick]);

  useEffect(() => {
    if (!focusPointId || !markersRef.current.length) return;
    const marker = markersRef.current.find(
      (m) => m.getExtData() && m.getExtData().id === focusPointId
    );
    if (marker && mapRef.current) {
      const position = marker.getPosition();
      mapRef.current.panTo(position, 200);
      window.setTimeout(() => {
        marker.emit('click', { target: marker });
      }, 100);
    }
  }, [focusPointId]);

  if (error) {
    return (
      <div style={mapFallbackStyle}>
        <div style={{ color: '#b91c1c', fontWeight: 600, marginBottom: 8 }}>地图加载失败</div>
        <div style={{ color: '#475569', fontSize: 13 }}>{error}</div>
      </div>
    );
  }

  if (!amapReady) {
    return (
      <div style={mapFallbackStyle}>
        <div
          style={{
            width: 36,
            height: 36,
            border: '4px solid #dbeafe',
            borderTop: '4px solid #3b82f6',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
        <div style={{ color: '#64748b', fontSize: 13, marginTop: 10 }}>正在加载地图...</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 460,
        borderRadius: 16,
        overflow: 'hidden',
      }}
    />
  );
}

const mapFallbackStyle = {
  width: '100%',
  height: '100%',
  minHeight: 460,
  borderRadius: 16,
  border: '1px solid #e2e8f0',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  background: '#f8fafc',
};

export default MapView;

