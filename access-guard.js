(function () {
  const page = document.currentScript?.dataset.guardPage;
  const rules = {
    feedback: {
      label: "Feedback",
      start: 10 * 60,
      startText: "10.00 WIB",
      end: null,
      endText: "",
    },
    sertifikat: {
      label: "Sertifikat",
      start: 10 * 60 + 30,
      startText: "10.30 WIB",
      end: 24 * 60,
      endText: "24.00 WIB",
    },
  };
  const rule = rules[page];

  if (!rule) {
    return;
  }

  const now = getJakartaTimeParts();
  const currentMinutes = now.hour * 60 + now.minute;
  let status = "";

  if (currentMinutes < rule.start) {
    status = "before";
  } else if (rule.end !== null && currentMinutes >= rule.end) {
    status = "after";
  }

  if (!status) {
    return;
  }

  const params = new URLSearchParams({
    page,
    status,
    label: rule.label,
    start: rule.startText,
    end: rule.endText,
  });

  window.location.replace(`./akses-ditutup.html?${params.toString()}`);
})();

function getJakartaTimeParts() {
  const formatter = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Jakarta",
  });
  const parts = formatter.formatToParts(new Date());
  const valueOf = (type) => Number(parts.find((part) => part.type === type)?.value || 0);

  return {
    hour: valueOf("hour"),
    minute: valueOf("minute"),
  };
}
