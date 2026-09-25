// Leitor de QR code pela câmera. Usa o leitor nativo do Chrome (BarcodeDetector)
// e, se não houver, a biblioteca jsQR.

let jsQRCarregado = null;
function carregarJsQR() {
  if (window.jsQR) return Promise.resolve();
  if (!jsQRCarregado) {
    jsQRCarregado = new Promise((ok, falha) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js";
      s.onload = ok;
      s.onerror = () => falha(new Error("Não consegui carregar o leitor de QR"));
      document.head.appendChild(s);
    });
  }
  return jsQRCarregado;
}

/**
 * Inicia a leitura. Chama aoLer(texto) uma única vez e para a câmera.
 * Retorna { parar(), lanterna(liga) , temLanterna }.
 */
export async function iniciarLeitor(video, aoLer, aoStatus) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play();

  const trilha = stream.getVideoTracks()[0];
  const capacidades = trilha.getCapabilities ? trilha.getCapabilities() : {};
  let ativo = true;
  let detector = null;
  if ("BarcodeDetector" in window) {
    try {
      const formatos = await window.BarcodeDetector.getSupportedFormats();
      if (formatos.includes("qr_code")) detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    } catch { detector = null; }
  }
  if (!detector) {
    aoStatus?.("Carregando leitor…");
    await carregarJsQR();
  }
  aoStatus?.("Aponte para o QR code da nota");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const parar = () => {
    ativo = false;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  const ciclo = async () => {
    if (!ativo) return;
    try {
      let texto = null;
      if (video.readyState >= 2) {
        if (detector) {
          const r = await detector.detect(video);
          if (r.length) texto = r[0].rawValue;
        } else {
          const w = video.videoWidth, h = video.videoHeight;
          const lado = Math.min(w, h, 900);
          canvas.width = lado; canvas.height = lado;
          const sx = (w - Math.min(w, h)) / 2, sy = (h - Math.min(w, h)) / 2;
          ctx.drawImage(video, sx, sy, Math.min(w, h), Math.min(w, h), 0, 0, lado, lado);
          const img = ctx.getImageData(0, 0, lado, lado);
          const r = window.jsQR(img.data, lado, lado, { inversionAttempts: "dontInvert" });
          if (r) texto = r.data;
        }
      }
      if (texto && ativo) {
        navigator.vibrate?.(60);
        parar();
        aoLer(texto);
        return;
      }
    } catch { /* quadro ruim, tenta o próximo */ }
    setTimeout(ciclo, 180);
  };
  ciclo();

  return {
    parar,
    temLanterna: !!capacidades.torch,
    lanterna: (liga) => trilha.applyConstraints({ advanced: [{ torch: liga }] }).catch(() => {}),
  };
}
