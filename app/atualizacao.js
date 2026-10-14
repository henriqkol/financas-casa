// Atualização automática do app (arquivo separado de app.js: funciona mesmo se app.js falhar ao carregar).
// A cada publicação o sw.js muda (o workflow troca o nome do cache). O app procura versão nova ao abrir,
// ao voltar para a tela, ao reconectar e a cada 30 min. Quando a nova assume, recarrega sozinho,
// esperando fechar uma janela aberta (ex.: editando um lançamento) para não atrapalhar.
(function () {
  if (!("serviceWorker" in navigator)) return;
  // página aberta sem service worker (primeira visita): a primeira troca é só a instalação, não recarrega
  var ignorarPrimeira = !navigator.serviceWorker.controller;
  var recarregando = false;
  function folhaAberta() { var f = document.getElementById("folha"); return !!f && !f.hidden; }
  function recarregar() {
    if (recarregando) return;
    recarregando = true;
    try { sessionStorage.setItem("app-atualizado", "1"); } catch (e) { /* sem armazenamento: só não mostra o aviso */ }
    location.reload();
  }
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (ignorarPrimeira) { ignorarPrimeira = false; return; }
    if (document.hidden || !folhaAberta()) return recarregar();
    var espera = setInterval(function () { if (!folhaAberta()) { clearInterval(espera); recarregar(); } }, 1000);
    document.addEventListener("visibilitychange", function () { if (document.hidden) { clearInterval(espera); recarregar(); } }, { once: true });
  });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(function (reg) {
    function procurar() { if (navigator.onLine) reg.update().catch(function () {}); }
    function assumir(sw) {
      if (sw) sw.addEventListener("statechange", function () { if (sw.state === "installed" && navigator.serviceWorker.controller) sw.postMessage("pular-espera"); });
    }
    if (reg.waiting && navigator.serviceWorker.controller) reg.waiting.postMessage("pular-espera");
    reg.addEventListener("updatefound", function () { assumir(reg.installing); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) procurar(); });
    window.addEventListener("online", procurar);
    setInterval(procurar, 30 * 60000);
  }).catch(function () {});
})();
