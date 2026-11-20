// =====================================================================
// Apps Script Kenal Jamsostek - versi aman (soal disajikan server)
// - Bank soal tetap di spreadsheet, tetapi spreadsheet TIDAK dipublish.
// - Kunci jawaban tidak pernah dikirim ke browser.
// - Soal dikirim SATU PER SATU. Soal berikutnya baru dikirim setelah
//   jawaban soal sebelumnya diterima, jadi daftar soal tidak bisa disedot.
// - Batas waktu per soal ditegakkan di server.
// - Skor dan durasi dihitung di server.
// - Feedback wajib kode sesi. Setiap sesi hanya 1 kali per nomor WA per hari per tema.
// =====================================================================

const RESPONSE_SHEET_NAME = "jawaban";
const BANK_SHEET_NAME = "bank_soal"; // GANTI sesuai nama tab bank soal Anda
const CODE_SHEET_NAME = "kode_sesi";
const EPISODE_SHEET_NAME = "episode";
const TIME_ZONE = "Asia/Jakarta";

const MAX_ACTIVE_QUESTIONS = 10;
const SECONDS_PER_QUESTION = 25; // batas waktu per soal
const ANSWER_GRACE_SECONDS = 5; // toleransi jaringan per soal
const MIN_SECONDS_PER_QUESTION = 2; // lebih cepat dari ini ditandai mencurigakan
const MAX_FOCUS_LOST = 2; // keluar layar lebih dari ini ditandai
const ATTEMPT_TTL_SECONDS = 2 * 60 * 60; // data pengerjaan disimpan 2 jam
const CODE_REQUIRED_SESSIONS = ["feedback"];
const ONE_ATTEMPT_SESSIONS = ["absensi", "feedback"];
const MAX_WRONG_CODE = 5; // salah kode lebih dari ini, nomor WA diblok 30 menit

const OPTION_KEYS = [
  ["A", "opsi_a"],
  ["B", "opsi_b"],
  ["C", "opsi_c"],
  ["D", "opsi_d"],
  ["E", "opsi_e"],
];

// --------------------------------------------------------------------
// Router
// --------------------------------------------------------------------

function doGet(event) {
  const params = (event && event.parameter) || {};
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  if (params.action === "themes") {
    return json_({ ok: true, themes: listThemes_(spreadsheet) });
  }

  const requestedSheetName = params.sheet || RESPONSE_SHEET_NAME;

  if (requestedSheetName === RESPONSE_SHEET_NAME) {
    return json_({ rows: publicResponseRows_(getOrCreateResponseSheet_(spreadsheet)) });
  }

  // Hanya sheet episode yang boleh dibaca. Bank soal dan kode sesi tertutup.
  if (requestedSheetName === EPISODE_SHEET_NAME) {
    const sheet = spreadsheet.getSheetByName(EPISODE_SHEET_NAME);
    return json_({ rows: sheet ? sheetToObjects_(sheet) : [] });
  }

  return json_({ rows: [] });
}

function doPost(event) {
  let payload = {};

  try {
    payload = JSON.parse((event && event.postData && event.postData.contents) || "{}");
  } catch (error) {
    return json_({ ok: false, message: "Format data tidak dikenali." });
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  if (payload.action === "certificate_print") {
    return json_(recordCertificatePrint_(getOrCreateResponseSheet_(spreadsheet), payload));
  }

  if (payload.action === "start") {
    return json_(startAttempt_(spreadsheet, payload));
  }

  if (payload.action === "answer") {
    return json_(answerQuestion_(spreadsheet, payload));
  }

  // Kiriman lama yang membawa skor sendiri ditolak.
  return json_({ ok: false, message: "Aksi tidak dikenal." });
}

// --------------------------------------------------------------------
// Mulai pengerjaan: validasi, pilih soal, simpan kunci di server
// --------------------------------------------------------------------

function startAttempt_(spreadsheet, payload) {
  const participant = sanitizeParticipant_(payload.participant || {});
  const session = String(payload.testSession || "").trim();
  const sessionKey = session.toLowerCase();
  const theme = String(payload.testTheme || "").trim();

  if (!participant.fullName || !participant.whatsappNumber || !participant.domicile || !theme) {
    return { ok: false, message: "Data peserta belum lengkap." };
  }

  if (["absensi", "feedback"].indexOf(sessionKey) < 0) {
    return { ok: false, message: "Sesi tidak dikenal." };
  }

  if (payload.extensionDetected) {
    return {
      ok: false,
      message: "Ekstensi browser terdeteksi. Matikan semua ekstensi atau pakai browser HP biasa, lalu muat ulang.",
    };
  }

  const now = new Date();
  const dateKey = Utilities.formatDate(now, TIME_ZONE, "yyyy-MM-dd");
  const phone = normalizePhone_(participant.whatsappNumber);
  const cache = CacheService.getScriptCache();
  const usedKey = "used:" + [sessionKey, phone, dateKey, theme.toLowerCase()].join("|");

  if (CODE_REQUIRED_SESSIONS.indexOf(sessionKey) >= 0) {
    const wrongKey = "wrongcode:" + phone;
    const wrongCount = Number(cache.get(wrongKey) || 0);

    if (wrongCount >= MAX_WRONG_CODE) {
      return { ok: false, message: "Terlalu banyak kode salah. Coba lagi 30 menit lagi." };
    }

    if (!isValidSessionCode_(spreadsheet, payload.sessionCode, now)) {
      cache.put(wrongKey, String(wrongCount + 1), 30 * 60);
      return { ok: false, message: "Kode sesi salah atau sudah tidak berlaku." };
    }
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    // Halaman dimuat ulang di tengah pengerjaan: lanjutkan soal yang sama, waktu tetap berjalan.
    const activeId = cache.get("active:" + usedKey);
    const activeRaw = activeId ? cache.get("att:" + activeId) : null;

    if (activeRaw) {
      return publicState_(JSON.parse(activeRaw), now);
    }

    if (ONE_ATTEMPT_SESSIONS.indexOf(sessionKey) >= 0) {
      if (cache.get(usedKey) || hasSubmitted_(spreadsheet, phone, dateKey, theme, sessionKey)) {
        return {
          ok: false,
          message: "Nomor WA ini sudah mengerjakan " + session + " hari ini untuk tema ini.",
        };
      }
    }

    const bankSession = sessionKey === "feedback" ? "POST" : "PRE";
    const pool = loadQuestionPool_(spreadsheet, theme, bankSession);

    if (pool.length === 0) {
      return { ok: false, message: "Tidak ada soal aktif untuk tema dan sesi ini." };
    }

    const items = selectBalancedQuestions_(pool).map(function (question) {
      const shuffled = shuffle_(question.options).map(function (option, index) {
        return { letter: OPTION_KEYS[index][0], text: option.text, original: option.original };
      });
      const correctOption = shuffled.filter(function (option) {
        return option.original === question.key;
      })[0];

      return {
        id: question.id,
        program: question.program,
        moduleName: question.moduleName,
        text: question.text,
        options: shuffled,
        correct: correctOption.letter,
        correctText: correctOption.text,
      };
    });

    const attempt = {
      id: Utilities.getUuid(),
      usedKey: usedKey,
      session: session,
      sessionKey: sessionKey,
      theme: theme,
      participant: participant,
      startedAt: now.getTime(),
      current: 0,
      issuedAt: now.getTime(),
      answers: [],
      focusLost: 0,
      extension: false,
      items: items,
    };

    // Tandai sejak mulai, supaya peserta tidak bisa membuka ulang untuk melihat soal baru.
    cache.put(usedKey, now.toISOString(), 6 * 60 * 60);
    cache.put("active:" + usedKey, attempt.id, ATTEMPT_TTL_SECONDS);
    saveAttempt_(attempt);
    return publicState_(attempt, now);
  } finally {
    lock.releaseLock();
  }
}

// --------------------------------------------------------------------
// Jawab satu soal, lalu terima soal berikutnya
// --------------------------------------------------------------------

function answerQuestion_(spreadsheet, payload) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get("att:" + String(payload.attemptId || ""));

  if (!raw) {
    return { ok: false, message: "Data pengerjaan tidak ditemukan atau sudah kedaluwarsa." };
  }

  const attempt = JSON.parse(raw);
  const now = new Date();

  attempt.focusLost = Math.max(attempt.focusLost, Math.floor(Number(payload.focusLostCount) || 0));
  attempt.extension = attempt.extension || payload.extensionDetected === true;

  // Kiriman ganda atau salah urutan: kirim ulang soal yang sedang aktif.
  if (Number(payload.index) !== attempt.current) {
    saveAttempt_(attempt);
    return publicState_(attempt, now);
  }

  const deadline = attempt.issuedAt + (SECONDS_PER_QUESTION + ANSWER_GRACE_SECONDS) * 1000;
  attempt.answers[attempt.current] = now.getTime() <= deadline ? normalizeAnswer_(payload.answer) : "";
  attempt.current += 1;
  attempt.issuedAt = now.getTime();

  if (attempt.current >= attempt.items.length) {
    cache.remove("att:" + attempt.id);
    cache.remove("active:" + attempt.usedKey);
    return finishAttempt_(spreadsheet, attempt, now);
  }

  saveAttempt_(attempt);
  return publicState_(attempt, now);
}

function finishAttempt_(spreadsheet, attempt, finishedAt) {
  const durationSeconds = Math.max(0, Math.round((finishedAt.getTime() - attempt.startedAt) / 1000));
  let correct = 0;

  const detail = attempt.items.map(function (item, index) {
    const selected = attempt.answers[index] || "";
    const isCorrect = selected !== "" && selected === item.correct;
    const selectedOption = item.options.filter(function (option) {
      return option.letter === selected;
    })[0];

    if (isCorrect) {
      correct += 1;
    }

    return {
      order: index + 1,
      questionId: item.id,
      moduleName: item.moduleName,
      question: item.text,
      selectedAnswer: selected,
      selectedAnswerText: selectedOption ? selectedOption.text : "",
      correctAnswer: item.correct,
      correctAnswerText: item.correctText,
      isCorrect: isCorrect,
    };
  });

  const total = attempt.items.length;
  const score = total ? Math.round((correct * 100) / total) : 0;
  const notes = [];

  if (durationSeconds < total * MIN_SECONDS_PER_QUESTION) {
    notes.push("TERLALU_CEPAT");
  }

  if (attempt.focusLost > MAX_FOCUS_LOST) {
    notes.push("KELUAR_LAYAR");
  }

  if (attempt.extension) {
    notes.push("EKSTENSI");
  }

  getOrCreateResponseSheet_(spreadsheet).appendRow([
    finishedAt,
    attempt.participant.fullName,
    attempt.participant.whatsappNumber,
    attempt.participant.companyName,
    attempt.participant.domicile,
    attempt.session,
    attempt.theme,
    durationSeconds,
    formatDuration_(durationSeconds),
    new Date(attempt.startedAt).toISOString(),
    finishedAt.toISOString(),
    score,
    total,
    score,
    JSON.stringify(detail),
    0,
    attempt.focusLost,
    notes.join(","),
  ]);

  return {
    ok: true,
    done: true,
    score: score,
    correct: correct,
    totalQuestions: total,
    durationSeconds: durationSeconds,
    durationText: formatDuration_(durationSeconds),
    flagged: notes.length > 0,
  };
}

function saveAttempt_(attempt) {
  CacheService.getScriptCache().put("att:" + attempt.id, JSON.stringify(attempt), ATTEMPT_TTL_SECONDS);
}

// Hanya soal yang sedang aktif yang dikirim ke browser, tanpa kunci.
function publicState_(attempt, now) {
  const item = attempt.items[attempt.current];
  const elapsed = Math.floor((now.getTime() - attempt.issuedAt) / 1000);

  return {
    ok: true,
    done: false,
    attemptId: attempt.id,
    index: attempt.current,
    total: attempt.items.length,
    secondsPerQuestion: SECONDS_PER_QUESTION,
    secondsLeft: Math.max(0, SECONDS_PER_QUESTION - elapsed),
    question: {
      text: item.text,
      moduleName: item.moduleName,
      options: item.options.map(function (option) {
        return { letter: option.letter, text: option.text };
      }),
    },
  };
}

function listThemes_(spreadsheet) {
  const rows = readSheetAsText_(spreadsheet.getSheetByName(BANK_SHEET_NAME));
  const themes = {};

  rows.forEach(function (row) {
    const theme = String(row.nama_modul || "").trim();

    if (theme && String(row.status || "").trim().toUpperCase() === "AKTIF") {
      themes[theme] = true;
    }
  });

  return Object.keys(themes).sort();
}

function loadQuestionPool_(spreadsheet, theme, bankSession) {
  const rows = readSheetAsText_(spreadsheet.getSheetByName(BANK_SHEET_NAME));

  return rows
    .map(function (row, index) {
      const options = OPTION_KEYS.map(function (pair) {
        return { original: pair[0], text: String(row[pair[1]] || "").trim() };
      }).filter(function (option) {
        return option.text;
      });

      return {
        id: row.id_soal || (row.kode_modul || "SOAL") + "-" + (row.no_soal || index + 2),
        status: String(row.status || "").trim().toUpperCase(),
        moduleName: String(row.nama_modul || "").trim(),
        program: String(row.program || "").trim().toUpperCase(),
        session: String(row.sesi || "").trim().toUpperCase(),
        text: String(row.pertanyaan || "").trim(),
        key: normalizeAnswer_(row.jawaban_benar || row.kunci || ""),
        options: options,
      };
    })
    .filter(function (question) {
      const sessionMatches =
        !question.session || question.session === "SEMUA" || question.session === bankSession;

      return (
        question.status === "AKTIF" &&
        question.moduleName === theme &&
        sessionMatches &&
        question.text &&
        question.options.length >= 2 &&
        question.options.some(function (option) {
          return option.original === question.key;
        })
      );
    });
}

function selectBalancedQuestions_(questions) {
  const programs = [];

  questions.forEach(function (question) {
    if (question.program && programs.indexOf(question.program) < 0) {
      programs.push(question.program);
    }
  });

  const selected = [];

  if (programs.length) {
    const baseQuota = Math.floor(MAX_ACTIVE_QUESTIONS / programs.length);
    let remainder = MAX_ACTIVE_QUESTIONS % programs.length;

    shuffle_(programs).forEach(function (program) {
      const quota = baseQuota + (remainder > 0 ? 1 : 0);
      remainder -= 1;
      const group = shuffle_(
        questions.filter(function (question) {
          return question.program === program;
        }),
      );
      Array.prototype.push.apply(selected, group.slice(0, quota));
    });
  }

  if (selected.length < MAX_ACTIVE_QUESTIONS) {
    const used = {};
    selected.forEach(function (question) {
      used[question.id] = true;
    });
    const leftovers = shuffle_(
      questions.filter(function (question) {
        return !used[question.id];
      }),
    );
    Array.prototype.push.apply(selected, leftovers.slice(0, MAX_ACTIVE_QUESTIONS - selected.length));
  }

  return shuffle_(selected).slice(0, MAX_ACTIVE_QUESTIONS);
}

// --------------------------------------------------------------------
// Kode sesi
// Sheet kode_sesi: tanggal | kode | buka | tutup
// Contoh: 20/11/2026 | 482913 | 10:00 | 10:20
// --------------------------------------------------------------------

function isValidSessionCode_(spreadsheet, code, now) {
  const input = String(code || "").trim().toUpperCase();

  if (!input) {
    return false;
  }

  const todayKey = Utilities.formatDate(now, TIME_ZONE, "yyyy-MM-dd");
  const nowMinutes = Number(Utilities.formatDate(now, TIME_ZONE, "H")) * 60 +
    Number(Utilities.formatDate(now, TIME_ZONE, "m"));
  const rows = readSheetAsText_(spreadsheet.getSheetByName(CODE_SHEET_NAME));

  return rows.some(function (row) {
    const open = toMinutes_(row.buka);
    const close = toMinutes_(row.tutup);

    return (
      normalizeDateKey_(row.tanggal) === todayKey &&
      String(row.kode || "").trim().toUpperCase() === input &&
      open !== null &&
      close !== null &&
      nowMinutes >= open &&
      nowMinutes < close
    );
  });
}

function toMinutes_(value) {
  const match = String(value || "").match(/(\d{1,2})[:.](\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// --------------------------------------------------------------------
// Sheet jawaban
// --------------------------------------------------------------------

function getOrCreateResponseSheet_(spreadsheet) {
  const sheet =
    spreadsheet.getSheetByName(RESPONSE_SHEET_NAME) || spreadsheet.insertSheet(RESPONSE_SHEET_NAME);
  const headers = [
    "timestamp",
    "nama_lengkap",
    "nomor_wa",
    "nama_perusahaan",
    "kota_domisili",
    "sesi",
    "tema",
    "lama_pengerjaan_detik",
    "lama_pengerjaan",
    "mulai_pengerjaan",
    "selesai_pengerjaan",
    "skor",
    "jumlah_soal",
    "persentase",
    "detail_jawaban",
    "cetak_sertif",
    "keluar_layar",
    "catatan",
  ];

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  } else {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  return sheet;
}

// Data publik: isi soal dan kunci di detail_jawaban dibuang, hanya status benar/salah.
function publicResponseRows_(sheet) {
  return sheetToObjects_(sheet).map(function (row) {
    let detail = [];

    try {
      detail = JSON.parse(row.detail_jawaban || "[]");
    } catch (error) {
      detail = [];
    }

    row.detail_jawaban = JSON.stringify(
      (Array.isArray(detail) ? detail : []).map(function (answer) {
        return { isCorrect: answer.isCorrect === true || answer.isCorrect === "true" };
      }),
    );
    return row;
  });
}

function hasSubmitted_(spreadsheet, phone, dateKey, theme, sessionKey) {
  const sheet = spreadsheet.getSheetByName(RESPONSE_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return false;
  }

  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(function (header) {
    return String(header || "").trim();
  });
  const phoneColumn = headers.indexOf("nomor_wa");
  const sessionColumn = headers.indexOf("sesi");
  const themeColumn = headers.indexOf("tema");
  const timestampColumn = headers.indexOf("timestamp");
  const themeKey = theme.trim().toLowerCase();

  return values.slice(1).some(function (row) {
    return (
      normalizePhone_(row[phoneColumn]) === phone &&
      String(row[sessionColumn] || "").trim().toLowerCase() === sessionKey &&
      String(row[themeColumn] || "").trim().toLowerCase() === themeKey &&
      normalizeDateKey_(row[timestampColumn]) === dateKey
    );
  });
}

function recordCertificatePrint_(sheet, payload) {
  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return { ok: false, message: "Data jawaban belum tersedia." };
  }

  const headers = values[0].map(function (header) {
    return String(header || "").trim();
  });
  const phoneColumn = headers.indexOf("nomor_wa");
  const sessionColumn = headers.indexOf("sesi");
  const timestampColumn = headers.indexOf("timestamp");
  const printColumn = headers.indexOf("cetak_sertif");

  if (phoneColumn < 0 || sessionColumn < 0 || timestampColumn < 0 || printColumn < 0) {
    return { ok: false, message: "Kolom cetak sertifikat belum lengkap." };
  }

  const requestedPhone = normalizePhone_(payload.phone || payload.nomor_wa || "");
  const requestedDate = normalizeDateKey_(payload.dateKey || payload.tanggal || new Date());
  let targetRowIndex = -1;

  for (let index = values.length - 1; index >= 1; index -= 1) {
    const row = values[index];
    const rowPhone = normalizePhone_(row[phoneColumn]);
    const rowSession = String(row[sessionColumn] || "").trim().toLowerCase().replace(/\s+/g, "");
    const rowDate = normalizeDateKey_(row[timestampColumn]);

    if (
      rowPhone === requestedPhone &&
      ["feedback", "posttest", "postest", "post"].indexOf(rowSession) >= 0 &&
      rowDate === requestedDate
    ) {
      targetRowIndex = index + 1;
      break;
    }
  }

  if (targetRowIndex < 0) {
    return { ok: false, message: "Data Feedback peserta tidak ditemukan." };
  }

  const currentCount = Number(sheet.getRange(targetRowIndex, printColumn + 1).getValue()) || 0;

  if (currentCount >= 2) {
    return { ok: false, count: currentCount, message: "Batas cetak sertifikat sudah tercapai." };
  }

  const nextCount = currentCount + 1;
  sheet.getRange(targetRowIndex, printColumn + 1).setValue(nextCount);
  return { ok: true, count: nextCount };
}

// --------------------------------------------------------------------
// Utilitas
// --------------------------------------------------------------------

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function readSheetAsText_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  const values = sheet.getDataRange().getDisplayValues();
  const headers = values[0].map(function (header) {
    return String(header || "").trim().toLowerCase().replace(/\s+/g, "_");
  });

  return values.slice(1).map(function (row) {
    return headers.reduce(function (record, header, index) {
      record[header] = row[index];
      return record;
    }, {});
  });
}

function sheetToObjects_(sheet) {
  const values = sheet.getDataRange().getValues();

  if (values.length < 2) {
    return [];
  }

  const headers = values[0].map(function (header) {
    return String(header || "").trim();
  });

  return values.slice(1).map(function (row) {
    return headers.reduce(function (record, header, index) {
      const value = row[index];
      record[header] = value instanceof Date ? value.toISOString() : value;
      return record;
    }, {});
  });
}

function sanitizeParticipant_(participant) {
  const clean = function (value, max) {
    return String(value || "").trim().slice(0, max);
  };

  return {
    fullName: clean(participant.fullName, 100),
    whatsappNumber: clean(participant.whatsappNumber, 20).replace(/\D/g, ""),
    companyName: clean(participant.companyName, 120),
    domicile: clean(participant.domicile, 80),
  };
}

function shuffle_(items) {
  const copy = items.slice();

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    const temp = copy[index];
    copy[index] = copy[randomIndex];
    copy[randomIndex] = temp;
  }

  return copy;
}

function normalizeAnswer_(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-E]/g, "").slice(0, 1);
}

function formatDuration_(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? seconds + " detik" : minutes + " menit " + seconds + " detik";
}

function normalizePhone_(value) {
  const digits = String(value || "").replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.indexOf("62") === 0) {
    return "0" + digits.slice(2);
  }

  if (digits.indexOf("8") === 0) {
    return "0" + digits;
  }

  return digits;
}

function normalizeDateKey_(value) {
  let date = value instanceof Date ? value : new Date(value);

  if (Object.prototype.toString.call(value) === "[object String]") {
    const match = value.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);

    if (match) {
      const year = match[3].length === 2 ? "20" + match[3] : match[3];
      return year + "-" + match[2].padStart(2, "0") + "-" + match[1].padStart(2, "0");
    }

    const iso = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (iso) {
      return value.trim();
    }
  }

  if (isNaN(date.getTime())) {
    return "";
  }

  return Utilities.formatDate(date, TIME_ZONE, "yyyy-MM-dd");
}
