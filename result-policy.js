(function () {
  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  function normalizePhone(value) {
    const digits = String(value ?? "").replace(/\D/g, "");

    if (!digits || /^0+$/.test(digits)) {
      return "";
    }

    if (digits.startsWith("62")) {
      return `0${digits.slice(2)}`;
    }

    return digits.startsWith("8") ? `0${digits}` : digits;
  }

  function getSessionType(value) {
    const session = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");

    if (["feedback", "posttest", "postest", "posttes", "post"].includes(session)) {
      return "post";
    }

    if (["absensi", "pretest", "pretes", "pre"].includes(session)) {
      return "pre";
    }

    return "";
  }

  function getTimestamp(value) {
    if (value === null || value === undefined || value === "") {
      return NaN;
    }

    // Legacy timestamps without an offset are interpreted as WIB, not the viewer's timezone.
    const text = String(value).trim();
    const local = text.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?))?$/);
    return local
      ? new Date(`${local[1]}T${local[2] || "00:00:00"}+07:00`).getTime()
      : new Date(value).getTime();
  }

  function getDateKey(value) {
    const timestamp = getTimestamp(value);

    if (!Number.isFinite(timestamp)) {
      return "";
    }

    const parts = dateFormatter.formatToParts(new Date(timestamp));
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }

  function getOfficialRows(rows) {
    const firstFeedback = new Map();

    rows.forEach((row, index) => {
      if (getSessionType(row.sesi || row.testSession) !== "post") {
        return;
      }

      const phone = normalizePhone(row.nomor_wa || row.whatsappNumber);
      const dateKey = getDateKey(row.timestamp || row.submittedAt);
      const theme = String(row.tema || row.testTheme || "")
        .normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

      // Incomplete legacy identities must not merge unrelated participants.
      if (!phone || !dateKey || !theme) {
        return;
      }

      const key = JSON.stringify([phone, dateKey, theme]);
      const timestamp = getTimestamp(row.timestamp || row.submittedAt);
      const first = firstFeedback.get(key);

      // The server timestamp wins; equal timestamps retain the original sheet row order.
      if (!first || timestamp < first.timestamp) {
        firstFeedback.set(key, { index, timestamp });
      }
    });

    const selectedIndexes = new Set([...firstFeedback.values()].map((entry) => entry.index));
    return rows.filter((row, index) => {
      if (getSessionType(row.sesi || row.testSession) !== "post") {
        return true;
      }

      const phone = normalizePhone(row.nomor_wa || row.whatsappNumber);
      const dateKey = getDateKey(row.timestamp || row.submittedAt);
      const theme = String(row.tema || row.testTheme || "").trim();
      return !phone || !dateKey || !theme || selectedIndexes.has(index);
    });
  }

  globalThis.ResultPolicy = Object.freeze({
    normalizePhone,
    getSessionType,
    getTimestamp,
    getDateKey,
    getOfficialRows,
  });
})();
