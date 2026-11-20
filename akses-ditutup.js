(function () {
  const params = new URLSearchParams(window.location.search);
  const page = params.get("page") || "";
  const status = params.get("status") || "";
  const label = params.get("label") || "Halaman";
  const start = params.get("start") || "";
  const end = params.get("end") || "";
  const labelElement = document.querySelector("#access-closed-label");
  const titleElement = document.querySelector("#access-closed-title");
  const messageElement = document.querySelector("#access-closed-message");
  const noteElement = document.querySelector("#access-closed-note");
  const linkElement = document.querySelector("#access-closed-link");

  labelElement.textContent = label;

  if (page === "feedback" && status === "before") {
    titleElement.textContent = "Form Feedback Belum dibuka";
    messageElement.textContent = "Silakan mengikuti sesi literasi hingga selesai terlebih dulu.";
    noteElement.textContent = "Silakan lakukan absensi terlebih dulu jika belum absen di link berikut:";
    linkElement.textContent = "Kembali ke Absensi";
    linkElement.href = "./index.html";
    return;
  }

  if (page === "sertifikat" && status === "before") {
    titleElement.textContent = "Sertifikat belum dibuka";
    messageElement.textContent = "Silakan mengikuti sesi literasi hingga selesai terlebih dulu.";
    noteElement.textContent = "Silakan lakukan absensi terlebih dulu jika belum absen di link berikut:";
    linkElement.textContent = "Kembali ke Absensi";
    return;
  }

  if (page === "sertifikat" && status === "after") {
    titleElement.textContent = "Sertifikat sudah ditutup";
    messageElement.textContent = "Nantikan episode DIJAMIN berikutnya. Terima kasih.";
    noteElement.textContent = "";
    linkElement.textContent = "Kembali ke Absensi";
  }
})();
