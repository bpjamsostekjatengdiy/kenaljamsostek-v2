// =====================================================================
// Apps Script Kenal Jamsostek - versi aman (soal disajikan server)
// - Bank soal tetap di spreadsheet, tetapi spreadsheet TIDAK dipublish.
// - Kunci jawaban tidak pernah dikirim ke browser.
// - Soal dikirim SATU PER SATU. Soal berikutnya baru dikirim setelah
//   jawaban soal sebelumnya diterima, jadi daftar soal tidak bisa disedot.
// - Tanpa batas waktu per soal. Durasi total dihitung di server.
// - Skor dan durasi dihitung di server.
// - Sesi (Absensi = pretest, Feedback = posttest) diatur di sheet sesi_aktif:
//   status AKTIF/NONAKTIF, jam buka-tutup, anti_curang ENABLE/DISABLE,
//   dan maks_percobaan per nomor WA per hari per tema.
// - Jatah percobaan dihitung dari sheet log_mulai. Hapus baris peserta di sana
//   untuk mengembalikan jatahnya.
// - Semua pesan ke peserta diambil dari sheet pesan (dibuat otomatis bila belum ada).
// - anti_curang ENABLE: deteksi ekstensi aktif saat pengerjaan. Ekstensi
//   terdeteksi = pengerjaan dihentikan dan hasil ditandai EKSTENSI.
// =====================================================================

const RESPONSE_SHEET_NAME = "jawaban";
const BANK_SHEET_NAME = "bank_soal"; // GANTI sesuai nama tab bank soal Anda
const SESSION_SHEET_NAME = "sesi_aktif";
const EPISODE_SHEET_NAME = "episode";
const SCRIPT_VERSION = "2026-11-23.5"; // cek lewat ?action=themes untuk memastikan deploy terbaru
const ALLOWLIST_SHEET_NAME = "pengecualian_ekstensi"; // pola elemen sisipan yang boleh diabaikan
const LOG_SHEET_NAME = "log_mulai"; // satu baris per klik mulai; hapus baris untuk mengembalikan jatah
const MESSAGE_SHEET_NAME = "pesan"; // template pesan yang tampil ke peserta
const TIME_ZONE = "Asia/Jakarta";

const MAX_ACTIVE_QUESTIONS = 10;
const MIN_SECONDS_PER_QUESTION = 2; // lebih cepat dari ini ditandai mencurigakan
const DEFAULT_MAX_FOCUS_LOST = 2; // keluar layar sebanyak ini atau lebih = tidak masuk peringkat (bila kolom kosong)
const ATTEMPT_TTL_SECONDS = 6 * 60 * 60; // data pengerjaan disimpan 6 jam (batas CacheService)
const DEFAULT_MAX_ATTEMPTS = 1; // dipakai bila kolom maks_percobaan kosong
const SESSION_HEADERS = ["sesi", "status", "tanggal", "buka", "tutup", "anti_curang", "maks_percobaan", "tampil_pembahasan", "batas_keluar_layar"];
const ATTEMPT_CHOICES = ["1", "2", "3", "4", "5", "10", "TANPA BATAS"];

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
    return json_({
      ok: true,
      themes: listThemes_(spreadsheet),
      sessions: listSessionOpen_(spreadsheet),
      sessionConfigs: listSessionConfigs_(spreadsheet),
      messages: getMessages_(spreadsheet),
      extensionAllowlist: getExtensionAllowlist_(spreadsheet),
      version: SCRIPT_VERSION,
    });
  }

  const requestedSheetName = params.sheet || RESPONSE_SHEET_NAME;

  if (requestedSheetName === RESPONSE_SHEET_NAME) {
    return json_({ rows: publicResponseRows_(getOrCreateResponseSheet_(spreadsheet)) });
  }

  // Hanya sheet episode yang boleh dibaca. Bank soal dan sheet lain tertutup.
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
    return { ok: false, message: msg_(spreadsheet, "data_belum_lengkap") };
  }

  if (["absensi", "feedback"].indexOf(sessionKey) < 0) {
    return { ok: false, message: "Sesi tidak dikenal." };
  }

  const now = new Date();
  const dateKey = Utilities.formatDate(now, TIME_ZONE, "yyyy-MM-dd");
  const phone = normalizePhone_(participant.whatsappNumber);
  const cache = CacheService.getScriptCache();
  const usedKey = "used:" + [sessionKey, phone, dateKey, theme.toLowerCase()].join("|");

  const config = getSessionConfig_(spreadsheet, sessionKey, now);

  if (!config.open) {
    return { ok: false, message: msg_(spreadsheet, "sesi_tutup", { sesi: session }) };
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

    // Jatah percobaan: dihitung dari sheet log_mulai (sejak klik mulai),
    // per nomor WA per hari per tema. Baris yang dihapus admin tidak dihitung.
    const usedCount = countStarts_(spreadsheet, phone, dateKey, theme, sessionKey);

    if (config.maxAttempts > 0 && usedCount >= config.maxAttempts) {
      return {
        ok: false,
        message: msg_(spreadsheet, "batas_percobaan", {
          sesi: session,
          terpakai: usedCount,
          maks: config.maxAttempts,
        }),
      };
    }

    const bankSession = sessionKey === "feedback" ? "POST" : "PRE";
    const pool = loadQuestionPool_(spreadsheet, theme, bankSession);

    if (pool.length === 0) {
      return { ok: false, message: msg_(spreadsheet, "soal_kosong", { sesi: session }) };
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
        explanation: question.explanation,
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
      copyAttempts: 0,
      extension: false,
      antiCheat: config.antiCheat,
      showReview: config.showReview,
      maxFocusLost: config.maxFocusLost,
      extensionSource: "",
      attemptNumber: usedCount + 1,
      maxAttempts: config.maxAttempts,
      items: items,
    };

    // Jatah terpakai sejak mulai, supaya peserta tidak bisa membuka ulang untuk melihat soal baru.
    getOrCreateLogSheet_(spreadsheet).appendRow([
      now,
      participant.fullName,
      participant.whatsappNumber,
      participant.companyName,
      participant.domicile,
      session,
      theme,
      attempt.id,
      usedCount + 1,
      "MULAI",
    ]);
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
    return { ok: false, message: msg_(spreadsheet, "pengerjaan_kedaluwarsa") };
  }

  const attempt = JSON.parse(raw);
  const now = new Date();

  // Sinyal kecurangan hanya dipakai bila anti_curang ENABLE.
  if (attempt.antiCheat) {
    attempt.focusLost = Math.max(attempt.focusLost, Math.floor(Number(payload.focusLostCount) || 0));
    attempt.copyAttempts = Math.max(attempt.copyAttempts || 0, Math.floor(Number(payload.copyAttempts) || 0));
    attempt.extension = attempt.extension || payload.extensionDetected === true;

    if (payload.extensionSource && !attempt.extensionSource) {
      attempt.extensionSource = String(payload.extensionSource).slice(0, 200);
    }
  }

  // Ekstensi terdeteksi di tengah pengerjaan: hentikan, sisa soal dianggap kosong.
  if (payload.abort === true && attempt.antiCheat) {
    attempt.extension = true;
    attempt.current = attempt.items.length;
    cache.remove("att:" + attempt.id);
    cache.remove("active:" + attempt.usedKey);
    return finishAttempt_(spreadsheet, attempt, now);
  }

  // Kiriman ganda atau salah urutan: kirim ulang soal yang sedang aktif.
  if (Number(payload.index) !== attempt.current) {
    saveAttempt_(attempt);
    return publicState_(attempt, now);
  }

  const answer = normalizeAnswer_(payload.answer);

  if (!answer) {
    return { ok: false, retry: true, message: msg_(spreadsheet, "pilih_jawaban") };
  }

  attempt.answers[attempt.current] = answer;
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

  const focusLimit = attempt.maxFocusLost === undefined ? DEFAULT_MAX_FOCUS_LOST : attempt.maxFocusLost;

  if (attempt.antiCheat && focusLimit > 0 && attempt.focusLost >= focusLimit) {
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
    attempt.antiCheat ? "ENABLE" : "DISABLE",
    attempt.copyAttempts || 0,
    attempt.attemptNumber || 1,
    attempt.extensionSource || "",
  ]);

  updateLogStatus_(
    spreadsheet,
    attempt.id,
    attempt.extension ? "DIHENTIKAN (EKSTENSI: " + (attempt.extensionSource || "-") + ")" : "SELESAI",
  );

  // Pembahasan hanya dikirim setelah pengerjaan selesai, bila tampil_pembahasan = YA
  // dan pengerjaan tidak dihentikan karena ekstensi.
  const review = attempt.showReview && !attempt.extension
    ? detail.map(function (row, index) {
        return {
          order: row.order,
          question: row.question,
          selectedAnswer: row.selectedAnswer,
          selectedAnswerText: row.selectedAnswerText,
          correctAnswer: row.correctAnswer,
          correctAnswerText: row.correctAnswerText,
          isCorrect: row.isCorrect,
          explanation: attempt.items[index].explanation || "",
        };
      })
    : [];

  return {
    ok: true,
    done: true,
    review: review,
    score: score,
    correct: correct,
    totalQuestions: total,
    durationSeconds: durationSeconds,
    durationText: formatDuration_(durationSeconds),
    flagged: notes.length > 0,
    flags: notes,
    focusLost: attempt.focusLost,
    maxFocusLost: focusLimit,
  };
}

function saveAttempt_(attempt) {
  CacheService.getScriptCache().put("att:" + attempt.id, JSON.stringify(attempt), ATTEMPT_TTL_SECONDS);
}

// Hanya soal yang sedang aktif yang dikirim ke browser, tanpa kunci.
function publicState_(attempt, now) {
  const item = attempt.items[attempt.current];

  return {
    ok: true,
    done: false,
    attemptId: attempt.id,
    index: attempt.current,
    total: attempt.items.length,
    elapsedSeconds: Math.max(0, Math.floor((now.getTime() - attempt.startedAt) / 1000)),
    antiCheat: attempt.antiCheat,
    attemptNumber: attempt.attemptNumber || 1,
    maxAttempts: attempt.maxAttempts,
    maxFocusLost: attempt.maxFocusLost === undefined ? DEFAULT_MAX_FOCUS_LOST : attempt.maxFocusLost,
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
        explanation: String(row.pembahasan || "").trim(),
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
// Sesi aktif - satu-satunya pengendali sesi
// Sheet sesi_aktif: sesi | status | tanggal | buka | tutup | anti_curang | maks_percobaan
//   sesi           : Absensi (pretest) atau Feedback (posttest)
//   status         : AKTIF untuk membuka, selain itu tertutup
//   tanggal, buka, tutup : opsional. Bila diisi, ikut dibatasi.
//   anti_curang    : ENABLE (canvas, blokir salin, deteksi ekstensi) atau DISABLE
//   maks_percobaan : 1, 2, 3, 4, 5, 10, atau TANPA BATAS
//   tampil_pembahasan : YA atau TIDAK
//   batas_keluar_layar : keluar layar sebanyak ini atau lebih = tidak masuk peringkat
//                        (1, 2, 3, 4, 5, 10, atau TANPA BATAS; hanya berlaku saat ENABLE)
// Kolom dan dropdown yang belum ada dibuat otomatis oleh ensureSessionSheet_.
// Tidak ada baris AKTIF untuk suatu sesi = sesi tertutup.
// --------------------------------------------------------------------

function getSessionConfig_(spreadsheet, sessionKey, now) {
  ensureSessionSheet_(spreadsheet);

  const todayKey = Utilities.formatDate(now, TIME_ZONE, "yyyy-MM-dd");
  const nowMinutes = Number(Utilities.formatDate(now, TIME_ZONE, "H")) * 60 +
    Number(Utilities.formatDate(now, TIME_ZONE, "m"));

  const match = readSheetAsText_(spreadsheet.getSheetByName(SESSION_SHEET_NAME)).filter(function (row) {
    const open = toMinutes_(row.buka);
    const close = toMinutes_(row.tutup);

    return (
      String(row.sesi || "").trim().toLowerCase() === sessionKey &&
      String(row.status || "").trim().toUpperCase() === "AKTIF" &&
      (!String(row.tanggal || "").trim() || normalizeDateKey_(row.tanggal) === todayKey) &&
      (open === null || nowMinutes >= open) &&
      (close === null || nowMinutes < close)
    );
  })[0];

  if (!match) {
    return {
      open: false,
      antiCheat: true,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      showReview: false,
      maxFocusLost: DEFAULT_MAX_FOCUS_LOST,
    };
  }

  const reviewText = String(match.tampil_pembahasan || "").trim().toUpperCase();

  return {
    open: true,
    antiCheat: String(match.anti_curang || "").trim().toUpperCase() !== "DISABLE",
    maxAttempts: parseMaxAttempts_(match.maks_percobaan),
    // Kosong: pretest (Absensi) menampilkan pembahasan, posttest (Feedback) tidak.
    showReview: reviewText ? reviewText === "YA" : sessionKey === "absensi",
    maxFocusLost: parseLimit_(match.batas_keluar_layar, DEFAULT_MAX_FOCUS_LOST),
  };
}

// 0 berarti tanpa batas.
function parseLimit_(value, fallback) {
  const text = String(value || "").trim().toUpperCase();

  if (text === "TANPA BATAS") {
    return 0;
  }

  const number = parseInt(text, 10);
  return number > 0 ? number : fallback;
}

// 0 berarti tanpa batas.
function parseMaxAttempts_(value) {
  const text = String(value || "").trim().toUpperCase();

  if (text === "TANPA BATAS") {
    return 0;
  }

  const number = parseInt(text, 10);
  return number > 0 ? number : DEFAULT_MAX_ATTEMPTS;
}

// Format lama (true/false) dipertahankan agar browser yang masih menyimpan versi lama tetap jalan.
function listSessionOpen_(spreadsheet) {
  const configs = listSessionConfigs_(spreadsheet);
  return { absensi: configs.absensi.open, feedback: configs.feedback.open };
}

function listSessionConfigs_(spreadsheet) {
  const now = new Date();
  const result = {};

  ["absensi", "feedback"].forEach(function (key) {
    const config = getSessionConfig_(spreadsheet, key, now);
    result[key] = {
      open: config.open,
      antiCheat: config.antiCheat,
      maxAttempts: config.maxAttempts,
      showReview: config.showReview,
      maxFocusLost: config.maxFocusLost,
    };
  });

  return result;
}

// Lengkapi kolom anti_curang, maks_percobaan, dan tampil_pembahasan beserta dropdown-nya bila belum ada.
function ensureSessionSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(SESSION_SHEET_NAME) || spreadsheet.insertSheet(SESSION_SHEET_NAME);
  const width = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0].map(function (header) {
    return String(header || "").trim().toLowerCase();
  });
  const missing = SESSION_HEADERS.filter(function (header) {
    return headers.indexOf(header) < 0;
  });

  if (missing.length === 0) {
    return;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    sheet.getRange(1, 1, 1, SESSION_HEADERS.length).setValues([SESSION_HEADERS]);
    sheet.getRange(2, 6, 19, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(["ENABLE", "DISABLE"], true).setAllowInvalid(false).build(),
    );
    sheet.getRange(2, 7, 19, 1).setNumberFormat("@").setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(ATTEMPT_CHOICES, true).setAllowInvalid(false).build(),
    );
    sheet.getRange(2, 8, 19, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(["YA", "TIDAK"], true).setAllowInvalid(false).build(),
    );
    sheet.getRange(2, 9, 19, 1).setNumberFormat("@").setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(ATTEMPT_CHOICES, true).setAllowInvalid(false).build(),
    );

    // Baris yang sudah ada diberi nilai awal: ENABLE, 1 kali, pembahasan YA untuk Absensi.
    const rows = Math.max(sheet.getLastRow() - 1, 0);

    if (rows > 0) {
      const current = sheet.getRange(2, 1, rows, 9).getDisplayValues();
      sheet.getRange(2, 6, rows, 4).setValues(
        current.map(function (row) {
          if (!String(row[0] || "").trim()) {
            return [row[5] || "", row[6] || "", row[7] || "", row[8] || ""];
          }

          const isPretest = String(row[0]).trim().toLowerCase() === "absensi";
          return [
            row[5] || "ENABLE",
            row[6] || String(DEFAULT_MAX_ATTEMPTS),
            row[7] || (isPretest ? "YA" : "TIDAK"),
            row[8] || String(DEFAULT_MAX_FOCUS_LOST),
          ];
        }),
      );
    }
  } finally {
    lock.releaseLock();
  }
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
    "anti_curang",
    "percobaan_salin",
    "percobaan_ke",
    "deteksi_ekstensi",
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

// --------------------------------------------------------------------
// Log mulai: satu baris per klik mulai. Dasar penghitungan jatah percobaan.
// --------------------------------------------------------------------

const LOG_HEADERS = [
  "timestamp",
  "nama_lengkap",
  "nomor_wa",
  "nama_perusahaan",
  "kota_domisili",
  "sesi",
  "tema",
  "attempt_id",
  "percobaan_ke",
  "status",
];

function getOrCreateLogSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(LOG_SHEET_NAME) || spreadsheet.insertSheet(LOG_SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(LOG_HEADERS);
  }

  return sheet;
}

function countStarts_(spreadsheet, phone, dateKey, theme, sessionKey) {
  const sheet = getOrCreateLogSheet_(spreadsheet);

  if (sheet.getLastRow() < 2) {
    return 0;
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

  return values.slice(1).filter(function (row) {
    return (
      normalizePhone_(row[phoneColumn]) === phone &&
      String(row[sessionColumn] || "").trim().toLowerCase() === sessionKey &&
      String(row[themeColumn] || "").trim().toLowerCase() === themeKey &&
      normalizeDateKey_(row[timestampColumn]) === dateKey
    );
  }).length;
}

function updateLogStatus_(spreadsheet, attemptId, status) {
  const sheet = spreadsheet.getSheetByName(LOG_SHEET_NAME);

  if (!sheet || sheet.getLastRow() < 2) {
    return;
  }

  const values = sheet.getDataRange().getValues();
  const idColumn = values[0].indexOf("attempt_id");
  const statusColumn = values[0].indexOf("status");

  for (let index = values.length - 1; index >= 1; index -= 1) {
    if (values[index][idColumn] === attemptId) {
      sheet.getRange(index + 1, statusColumn + 1).setValue(status);
      return;
    }
  }
}

// --------------------------------------------------------------------
// Template pesan (sheet pesan: kode | pesan | keterangan)
// Ubah kolom pesan untuk mengganti teks. Jangan ubah kolom kode.
// Teks dalam kurung kurawal, misalnya {sesi}, diganti otomatis.
// Baris yang hilang dibuat ulang dengan teks bawaan.
// --------------------------------------------------------------------

const DEFAULT_MESSAGES = [
  ["sesi_tutup", "Sesi {sesi} belum dibuka atau sudah ditutup.", "Sesi berstatus tertutup di sesi_aktif. {sesi}"],
  ["data_belum_lengkap", "Data peserta belum lengkap.", "Nama, nomor WA, atau kota belum diisi."],
  ["batas_percobaan", "Nomor WA ini sudah memakai {terpakai} dari {maks} kesempatan {sesi} hari ini untuk tema ini.", "Jatah maks_percobaan habis. {terpakai} {maks} {sesi}"],
  ["soal_kosong", "Tidak ada soal aktif untuk tema dan sesi ini.", "Bank soal tidak punya soal AKTIF untuk tema/sesi ini. {sesi}"],
  ["pengerjaan_kedaluwarsa", "Data pengerjaan tidak ditemukan atau sudah kedaluwarsa.", "Pengerjaan lebih dari 6 jam atau data sudah dipakai."],
  ["pilih_jawaban", "Pilih satu tanggapan dulu.", "Peserta menekan Lanjut tanpa memilih jawaban."],
  ["tema_belum_aktif", "Belum ada tema aktif.", "Halaman registrasi, bila tidak ada tema AKTIF."],
  ["tema_gagal_dimuat", "Tema belum bisa dimuat.", "Halaman registrasi, bila koneksi ke server gagal."],
  ["koneksi_bermasalah", "Koneksi bermasalah. Coba lagi.", "Gagal memulai karena koneksi."],
  ["aturan_enable", "Butir tidak bisa diulang. Jangan keluar dari halaman ini. Menyalin soal dan ekstensi browser (termasuk asisten AI) tidak diizinkan.", "Teks di atas soal saat anti_curang ENABLE."],
  ["aturan_disable", "Butir tidak bisa diulang.", "Teks di atas soal saat anti_curang DISABLE."],
  ["peringatan_salin", "⚠ Menyalin soal tidak diizinkan. Percobaan tercatat ({jumlah}x).", "Saat peserta mencoba salin/klik kanan (ENABLE). {jumlah}"],
  ["peringatan_keluar_layar", "⚠ Anda keluar dari halaman quiz {jumlah}x. Keluar {batas}x, hasil tidak masuk peringkat.", "Saat peserta kembali ke halaman quiz, belum mencapai batas_keluar_layar (ENABLE). {jumlah} {batas}"],
  ["keluar_layar_melewati_batas", "⚠ Anda sudah keluar dari halaman quiz {jumlah}x. Hasil Anda tidak masuk peringkat.", "Saat jumlah keluar mencapai batas_keluar_layar (ENABLE). {jumlah} {batas}"],
  ["ekstensi_terdeteksi", "⚠ EKSTENSI BROWSER TERDETEKSI. Pengerjaan dihentikan.", "Notifikasi saat ekstensi terdeteksi (ENABLE)."],
  ["pengerjaan_dihentikan_judul", "⚠ PENGERJAAN DIHENTIKAN", "Judul kotak hasil saat ekstensi terdeteksi."],
  ["pengerjaan_dihentikan_isi", "Ekstensi browser terdeteksi saat mengerjakan. Sisa soal dianggap kosong dan hasil Anda tidak masuk peringkat.", "Isi kotak hasil saat ekstensi terdeteksi."],
  ["sumber_ekstensi", "Terdeteksi: {sumber}", "Baris kecil di kotak hasil: elemen sisipan yang terdeteksi. Salin teks ini ke sheet pengecualian_ekstensi bila ingin diabaikan. {sumber}"],
  ["hasil_keluar_layar_judul", "⚠ TIDAK MASUK PERINGKAT", "Judul kotak di halaman hasil bila keluar layar mencapai batas."],
  ["hasil_keluar_layar", "Anda keluar/pindah dari halaman quiz {jumlah}x (batas {batas}x). Hasil Anda tetap tersimpan, tetapi tidak masuk peringkat.", "Isi kotak di halaman hasil bila keluar layar mencapai batas. {jumlah} {batas}"],
  ["hasil_terlalu_cepat", "Pengerjaan terlalu cepat sehingga hasil Anda tidak masuk peringkat.", "Isi kotak di halaman hasil bila pengerjaan terlalu cepat."],
  ["hasil_dengan_pembahasan", "Jawaban tersimpan. Pembahasan tiap butir ada di bawah.", "Halaman hasil bila tampil_pembahasan YA."],
  ["hasil_tanpa_pembahasan", "Jawaban tersimpan. Kunci dan pembahasan dibagikan setelah sesi ditutup.", "Halaman hasil bila tampil_pembahasan TIDAK."],
  ["jawaban_gagal_terkirim", "Jawaban belum terkirim. Muat ulang halaman dan isi data yang sama untuk melanjutkan.", "Jawaban gagal dikirim 3 kali."],
];

// --------------------------------------------------------------------
// Pengecualian ekstensi (sheet pengecualian_ekstensi: pola | keterangan)
// Isi pola dengan sebagian teks "Terdeteksi: ..." dari halaman hasil,
// misalnya grammarly. Elemen yang cocok tidak dianggap kecurangan.
// --------------------------------------------------------------------

function getExtensionAllowlist_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(ALLOWLIST_SHEET_NAME) || spreadsheet.insertSheet(ALLOWLIST_SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["pola", "keterangan"]);
  }

  return readSheetAsText_(sheet)
    .map(function (row) {
      return String(row.pola || "").trim().toLowerCase();
    })
    .filter(function (pattern) {
      return pattern.length >= 3;
    });
}

let messageCache_ = null;

function getMessages_(spreadsheet) {
  if (messageCache_) {
    return messageCache_;
  }

  const sheet = spreadsheet.getSheetByName(MESSAGE_SHEET_NAME) || spreadsheet.insertSheet(MESSAGE_SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["kode", "pesan", "keterangan"]);
  }

  // Teks bawaan versi lama yang maknanya sudah berubah diganti otomatis (bila belum diubah admin).
  const OUTDATED = { peringatan_keluar_layar: "⚠ Anda keluar dari halaman quiz {jumlah}x. Lebih dari {batas}x tidak masuk peringkat." };
  if (sheet.getLastRow() > 1) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues();
    values.forEach(function (row, index) {
      const key = String(row[0] || "").trim();
      if (OUTDATED[key] && row[1] === OUTDATED[key]) {
        const fresh = DEFAULT_MESSAGES.filter(function (item) { return item[0] === key; })[0];
        sheet.getRange(index + 2, 2, 1, 2).setValues([[fresh[1], fresh[2]]]);
      }
    });
  }

  const result = {};
  readSheetAsText_(sheet).forEach(function (row) {
    const key = String(row.kode || "").trim();

    if (key && String(row.pesan || "").trim()) {
      result[key] = String(row.pesan);
    }
  });

  // Tambahkan baris bawaan yang belum ada.
  const missing = DEFAULT_MESSAGES.filter(function (item) {
    return !(item[0] in result);
  });

  if (missing.length) {
    const existingKeys = readSheetAsText_(sheet).map(function (row) {
      return String(row.kode || "").trim();
    });
    const toAppend = missing.filter(function (item) {
      return existingKeys.indexOf(item[0]) < 0;
    });

    if (toAppend.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, 3).setValues(toAppend);
    }

    missing.forEach(function (item) {
      result[item[0]] = item[1];
    });
  }

  messageCache_ = result;
  return result;
}

function msg_(spreadsheet, key, vars) {
  const template = getMessages_(spreadsheet)[key] || key;
  return fillTemplate_(template, vars || {});
}

function fillTemplate_(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, function (match, name) {
    return name in vars ? String(vars[name]) : match;
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
