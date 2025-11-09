// frontend/src/mapLoader.js
let amapPromise = null;

export function loadAmapScript() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('AMap can only be loaded in browser environment'));
  }
  if (window.AMap) {
    return Promise.resolve(window.AMap);
  }
  if (amapPromise) {
    return amapPromise;
  }
  const key = import.meta.env.VITE_AMAP_KEY;
  if (!key) {
    return Promise.reject(new Error('VITE_AMAP_KEY 未配置，无法加载高德地图'));
  }
  amapPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${key}&callback=__initAmapCallback`;
    script.async = true;
    script.defer = true;
    window.__initAmapCallback = () => {
      resolve(window.AMap);
      delete window.__initAmapCallback;
    };
    script.onerror = (err) => {
      reject(new Error('高德地图脚本加载失败'));
      delete window.__initAmapCallback;
    };
    document.head.appendChild(script);
  });
  return amapPromise;
}

export function isAmapLoaded() {
  return typeof window !== 'undefined' && !!window.AMap;
}

