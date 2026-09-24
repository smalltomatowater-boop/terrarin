// =====================================
// てらりん (terrarin) - 複数AIキャラクターの自律会話オーケストレーター
// Version: 1.0.0
//
// 複数のAIキャラクター（ゲストBot）がSlackチャンネルで自律的に会話するボット。
// LLMエンジンは「さくらのAI」「Google AI Studio (Gemini)」の2択に固定
// （動的なエンジン切り替えテーブルは持たない。詳細は _callTerrariumBotLLM 参照）。
//
// 元は LINORIN（https://www.linorin.jp / https://github.com/smalltomatowater-boop/LINORIN-free）
// の「AIテラリウム」機能を切り出したもの。LINORIN本体では独立モジュールとして
// terrarium.js が分離されていたが、tera はその切り出し先そのものなのでファイルを
// 分ける理由がなく、1ファイルにまとめている。おおまかな構成:
//   §1 基盤（config/シート/LLM呼び出し/エントリポイント/setup） … 旧 Core.js 相当
//   §2 テラリウム本体ロジック                                    … 旧 terrarium.js 相当
//
// 詳細は README.md と docs/TERRARIUM_SPEC.md を参照。
// =====================================

// =====================================
// セットアップ（GASエディタから手動実行。初回・バージョンアップ後・設定変更後に実行）
// GASエディタの実行対象ドロップダウンで見つけやすいようファイル先頭に置いている。
// =====================================
function setup() {
  // config シート初期化（既存キーは上書きしない。新規キーだけ追加）
  let cfgSheet = getTeraSS().getSheetByName("config");
  if (!cfgSheet) {
    cfgSheet = getTeraSS().insertSheet("config");
    cfgSheet.appendRow(["key", "value"]);
  }
  const existing = cfgSheet.getDataRange().getValues();
  const existingKeys = new Set(existing.slice(1).map(r => String(r[0]).trim()));
  const toAppend = _TERA_DEFAULT_CONFIG_.filter(([k]) => !existingKeys.has(k));
  if (toAppend.length) {
    cfgSheet.getRange(cfgSheet.getLastRow() + 1, 1, toAppend.length, 2).setValues(toAppend);
  }

  // DIAG_TOKEN 自動生成（未設定時のみ）
  const props = PropertiesService.getScriptProperties();
  getCONFIG();
  let diagToken = CONFIG["DIAG_TOKEN"] || "";
  if (!diagToken) {
    diagToken = Utilities.getUuid().replace(/-/g, '');
    let found = false;
    const data = cfgSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === "DIAG_TOKEN") {
        cfgSheet.getRange(i + 1, 2).setValue(diagToken);
        found = true;
        break;
      }
    }
    if (!found) cfgSheet.appendRow(["DIAG_TOKEN", diagToken]);
    Logger.log("🔑 DIAG_TOKEN 生成完了: " + diagToken);
  }

  // テスト用URL（診断API）を組み立てて出力。doGet/doPost が一度でも実行されていれば
  // 正しい /exec URL が _deployed_url に保存されているのでそれを使う。まだ無ければ
  // （まだ一度もリクエストが来ていない＝初回セットアップ時）その旨を案内する。
  const deployedUrl = props.getProperty('_deployed_url') || '';
  if (deployedUrl) {
    Logger.log("🔗 テスト用URL: " + deployedUrl + "?target=terrarium&token=" + diagToken);
  } else {
    Logger.log("🔗 テスト用URL: （まだ確定していません。デプロイ時に発行されたURLに "
      + "?target=terrarium&token=" + diagToken + " を付けてください。一度アクセスするか"
      + "Slackイベントを1回受信すると、次回 setup() 実行時にここへ自動でURLが表示されます）");
  }

  // テラリウム用シート
  getSheet("terrarium_queue", [
    "queue_id", "type", "ts", "thread_ts", "text",
    "user", "bot_id", "username", "is_bot",
    "status", "created_at", "processed_at", "result", "extra"
  ]);
  getSheet("terrarium_threads", [
    "thread_id", "thread_ts", "title", "created_at", "last_activity",
    "message_count", "status", "bot_id", "last_message"
  ]);
  // terrarium_logs は §2 側が初回アクセス時に自動作成する

  // トリガー再構築
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("scheduledEveryMinute").timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger("dailyReset").timeBased().atHour(17).everyDays(1).create();

  _clearConfigCache_();
  Logger.log("✅ tera セットアップ完了");
}

const EMPTY_USER_MSG_FALLBACK = "（状況に応じて自然に話しかけてください）";

let CONFIG = null;

// =====================================
// スプレッドシート・シート基盤
// =====================================

function getTeraSS() {
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (e) {}
  const ssId = PropertiesService.getScriptProperties().getProperty('TERA_SPREADSHEET_ID');
  if (ssId) {
    try { return SpreadsheetApp.openById(ssId); } catch (e) { Logger.log("[getTeraSS] openById failed: " + e); }
  }
  return null;
}

function getSheet(name, headers) {
  const ss = getTeraSS();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

// =====================================
// Config（config シート: A列=key, B列=value）
// =====================================

// setup() が config シートに書き込む初期キー。値は空文字のものはユーザーが埋める前提。
const _TERA_DEFAULT_CONFIG_ = [
  ["SLACK_BOT_TOKEN", ""],
  ["TERRARIUM_CHANNEL_ID", ""],
  ["GEMINI_API_KEY", ""],
  ["GEMINI_MODEL", "gemini-flash-lite-latest"],
  ["GEMINI_FALLBACK_MODEL", ""],
  ["SAKURA_ACCESS_TOKEN", ""],
  ["SAKURA_MODEL", ""],
  ["TERRARIUM_ENABLED", "FALSE"],
  ["TERRARIUM_MIN_MESSAGES", "1"],
  ["TERRARIUM_MAX_LOG_ROWS", "500"],
  ["TERRARIUM_SPONTANEOUS_PROB", "0.03"],
  ["terrarium_max_threads", "3"],
  ["terrarium_hourly_limit", "5"],
  ["terrarium_reply_delay_max", "0"],
  ["terrarium_loneliness_min", "0"],
  ["terrarium_queue_max_per_run", "2"],
  ["terrarium_bot_memory_msgs", "3"],
  ["terrarium_force_topic", ""],
  ["terrarium_templates", ""],
  ["TERRARIUM_AUTO_MORNING", "FALSE"],
  ["TERRARIUM_AUTO_DAY", "FALSE"],
  ["TERRARIUM_AUTO_EVENING", "FALSE"],
  ["TERRARIUM_AUTO_NIGHT", "FALSE"],
  // キャラクター定義はこのJSON配列1項目に一本化（§2の「パートナー参加」機能は
  // LINORIN本体固有のconfigキーに依存し tera 単体では機能しないため未サポート）。
  // 初期値はサンプル2キャラ（両方 engine:gemini。GEMINI_API_KEY だけ設定すれば
  // そのまま動く。中身を書き換えるか、TERRARIUM_ENABLED をTRUEにすればすぐ試せる）。
  ["terrarium_bots", '[{"name":"ミナ","inst":"元気でおせっかいな後輩キャラ。タメ口で話す。","emoji":":sparkles:","engine":"gemini"},{"name":"リョウ","inst":"皮肉屋だけど面倒見がいい先輩キャラ。落ち着いた口調。","emoji":":coffee:","engine":"gemini"}]'],
  ["temperature", "1"],
  ["maxOutputTokens", "2048"],
  ["topP", "0.95"]
];

function getCONFIG() {
  if (!CONFIG) CONFIG = loadAllConfig();
  return CONFIG;
}

function loadAllConfig() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get("TERA_CONFIG_CACHE");
    if (cached) return JSON.parse(cached);
  } catch (e) {}

  const ss = getTeraSS();
  if (!ss) return {};
  const sheet = ss.getSheetByName("config");
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  const map = {};
  data.slice(1).forEach(r => {
    const key = String(r[0]).trim();
    if (!key) return;
    const v = r[1];
    const val = (v === false) ? "FALSE" : (v === true) ? "TRUE" : (v === 0) ? "0" : String(v || "");
    // 同じキーの行が重複している場合、空の行が後にあっても既存の値を消さない
    // （手動編集で空行が増えても既存設定が壊れないようにするための保険）
    if (val === "" && map[key] !== undefined) return;
    map[key] = val;
  });

  try {
    const json = JSON.stringify(map);
    if (json.length < 90000) CacheService.getScriptCache().put("TERA_CONFIG_CACHE", json, 3600);
  } catch (e) {}

  return map;
}

function _clearConfigCache_() {
  try { CacheService.getScriptCache().remove("TERA_CONFIG_CACHE"); } catch (e) {}
  CONFIG = null;
}

function _getMaxTokens_() { return Number(CONFIG["maxOutputTokens"] || 2048); }
function _computeFinalTemperature_() {
  return Math.min(2, Math.max(0.1, Number(CONFIG["temperature"] || 1)));
}

/**
 * タイミングセーフな文字列比較（トークン認証用）。LINORIN本体と同じ実装。
 */
function _safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// =====================================
// テキスト整形（LLM出力の思考プロセス除去等）
// =====================================
function sanitize(text) {
  if (!text) return "";
  let result = text;

  if (/^[^一-鿿぀-ヿa-zA-Z]*[a-zA-Z]/.test(result)) {
    result = result.replace(/^[\s\S]*?([一-鿿぀-ゟ゠-ヿ])/u, "$1");
  }
  result = result.replace(/^[\s\S]*\*[^*]+\*\s*/u, "");
  result = result.replace(/^\s*(Draft|Plan|Analysis|Role|Personality|Wait|Let me|I should|Wait,)[^\n]*\n?/gim, "");
  result = result.replace(/^[\s]*[-*]\s+[^\n]*\n?/gm, "");
  result = result
    .replace(/^[\s　]*[（ (【［\[].*?[）)】］\]]\s*/g, "")
    .replace(/^\*[^*]+\*\s*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return result;
}

// =====================================
// LLM: Google AI Studio (Gemini)
// =====================================
function callGemini(message, modelOverride, userId, imageBase64, temperature) {
  try {
    const apiKey = CONFIG["GEMINI_API_KEY"];
    const useModel = modelOverride || CONFIG["GEMINI_MODEL"];

    if (!apiKey) return { error: true, type: "system", status: "NO_KEY" };
    if (!useModel) return { error: true, type: "system", status: "NO_MODEL" };

    const userText = (message.user && String(message.user).trim()) ? message.user : EMPTY_USER_MSG_FALLBACK;
    let parts = [{ text: userText }];
    if (imageBase64) {
      parts.push({ inlineData: { mimeType: "image/jpeg", data: imageBase64 } });
    }

    const payload = {
      systemInstruction: { parts: [{ text: message.system }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: temperature,
        maxOutputTokens: _getMaxTokens_(),
        topP: Number(CONFIG["topP"] || 0.95)
      }
    };

    let res;
    try {
      res = UrlFetchApp.fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + useModel + ":generateContent",
        {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify(payload),
          headers: { "x-goog-api-key": apiKey },
          muteHttpExceptions: true
        }
      );
    } catch (e) {
      return { error: true, type: "network" };
    }

    const status = res.getResponseCode();
    const rawBody = res.getContentText() || "{}";
    let json;
    try { json = JSON.parse(rawBody); } catch (_) { json = {}; }

    if (json.error || status >= 400) {
      Logger.log("[Gemini] ERROR status=" + status + " model=" + useModel + " err=" + JSON.stringify(json.error || rawBody.slice(0, 200)));
      if (status === 404 && !modelOverride) {
        const fallbackModel = "gemini-flash-lite-latest";
        Logger.log("[Gemini] 404: model deprecated, retry with " + fallbackModel);
        return callGemini(message, fallbackModel, userId, imageBase64, temperature);
      }
      return { error: true, type: "api", status };
    }

    const c0 = json.candidates && json.candidates[0];
    const finishReason = c0 && c0.finishReason;
    const parts0 = c0 && c0.content && c0.content.parts;
    const text = parts0 ? parts0.map(function (p) { return p.text || ""; }).join("") : "";

    Logger.log("[Gemini] OK model=" + useModel + " status=" + status + " finish=" + finishReason + " text_len=" + text.length);
    return { error: false, text, model: useModel };

  } catch (e) {
    Logger.log("[Gemini] EXCEPTION: " + e + " stack=" + e.stack);
    return { error: true, type: "system" };
  }
}

/** Gemini 503/429 時に GEMINI_FALLBACK_MODEL へ切り替えるラッパー（任意。使わなくてもよい） */
function callGeminiWithFallback(message, userId, imageBase64, temperature) {
  const mainModel = CONFIG["GEMINI_MODEL"];
  const fallbackModel = CONFIG["GEMINI_FALLBACK_MODEL"];
  const result = callGemini(message, mainModel, userId, imageBase64, temperature);
  if (!result.error || !fallbackModel || fallbackModel === mainModel) return result;
  if (result.status !== 503 && result.status !== 429) return result;
  Logger.log("[GeminiFallback] " + result.status + " on " + mainModel + " → fallback to " + fallbackModel);
  return callGemini(message, fallbackModel, userId, imageBase64, temperature);
}

// =====================================
// LLM: さくらのAI（OpenAI互換）
// =====================================
function callSakura(message, model, imageBase64, userId, temperature) {
  try {
    const apiKey = CONFIG["SAKURA_ACCESS_TOKEN"] || CONFIG["SAKURA_API_KEY"] || "";
    const useModel = model || CONFIG["SAKURA_MODEL"];

    if (!apiKey) return { error: true, type: "system", status: "NO_KEY" };
    if (!useModel) return { error: true, type: "system", status: "NO_MODEL" };

    const userText = message.user && String(message.user).trim().length > 0 ? message.user : EMPTY_USER_MSG_FALLBACK;

    const userContent = imageBase64
      ? [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64," + imageBase64 } }
        ]
      : userText;

    let messages;
    if (!userText) {
      messages = [{ role: "user", content: message.system || "." }];
    } else {
      messages = [
        { role: "system", content: message.system },
        { role: "user", content: userContent }
      ];
    }

    const payload = {
      model: useModel,
      messages,
      max_tokens: _getMaxTokens_(),
      temperature: temperature || 0.7,
      stream: false
    };

    let res;
    try {
      res = UrlFetchApp.fetch(
        "https://api.ai.sakura.ad.jp/v1/chat/completions",
        {
          method: "post",
          contentType: "application/json",
          headers: { "Authorization": "Bearer " + apiKey, "Accept": "application/json" },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        }
      );
    } catch (e) {
      return { error: true, type: "network" };
    }

    const status = res.getResponseCode();
    const body = res.getContentText() || "{}";
    const json = JSON.parse(body);
    if (json.error) {
      Logger.log("Sakura API error [" + status + "]: " + JSON.stringify(json.error));
      return { error: true, type: "api", status, apiMessage: json.error.message || "" };
    }

    const text = json.choices?.[0]?.message?.content || "";
    if (!text) Logger.log("⚠️ Sakura: レスポンステキストが空 model=" + useModel);
    return { error: false, text, model: useModel };

  } catch (e) {
    Logger.log("Sakura system error: " + e);
    return { error: true, type: "system" };
  }
}

// =====================================
// サブシステム排他ロック（LINORIN本体と同じ実装）
// =====================================
function _runSubsystemLocked_(name, fn) {
  try {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(0)) {
      Logger.log("[" + name + "] lock busy (another execution running this subsystem), skipping");
      return;
    }
    try { fn(); } finally { lock.releaseLock(); }
  } catch (e) {
    Logger.log("[" + name + "] guard error: " + e);
  }
}

// =====================================
// デプロイURLの捕捉（LINORIN本体と同じ理由）
// GASエディタから直接 setup() を実行した場合の ScriptApp.getService().getUrl() は
// 「HEAD」デプロイURL（/dev 相当）を返すことがあり、実際に発行した /exec の
// バージョン付きデプロイURLと食い違うことがある。doGet/doPost は実際のリクエストが
// 来た経路の正しいURLを返すため、ここで一度キャプチャして setup() から再利用する。
// =====================================
function _captureDeployedUrl_() {
  try {
    const url = ScriptApp.getService().getUrl();
    if (url) PropertiesService.getScriptProperties().setProperty('_deployed_url', url.replace(/\/dev$/, '/exec'));
  } catch (e) {}
}

// =====================================
// エントリポイント
// =====================================

function doPost(e) {
  try {
    _captureDeployedUrl_();
    const rawBody = e && e.postData ? e.postData.contents : "(empty)";
    const body = JSON.parse(rawBody);

    // Slack URL verification
    if (body.type === "url_verification") {
      return ContentService.createTextOutput(body.challenge);
    }

    // Slack event（署名検証はGAS exec URLのリダイレクトでヘッダーが消失するため実装不可。
    // 代わりに terrarium.js 側で SLACK_CHANNEL_ID 照合 + event_id dedup により防御）
    if (body.event && body.event.type) {
      let rawTs = null;
      let tsMatch = rawBody.match(/"ts"\s*:\s*"([^"]+)"/);
      if (!tsMatch) tsMatch = rawBody.match(/"ts"\s*:\s*([0-9.]+)/);
      if (tsMatch) rawTs = String(tsMatch[1]);

      getCONFIG();
      if (typeof _terrariumHandleSlackEvent === 'function') {
        _terrariumHandleSlackEvent(body, rawTs);
      }
      return ContentService.createTextOutput("ok");
    }

    return ContentService.createTextOutput("ok");

  } catch (err) {
    // 未捕捉例外を握りつぶして必ず200を返す（GASが302を返すとSlackがリトライの雪崩を起こす）
    Logger.log("doPost uncaught error: " + err + " | stack: " + (err && err.stack ? err.stack : ""));
    return ContentService.createTextOutput("ok");
  }
}

// ?target=terrarium / terrarium-threads / terrarium-queue / force-thread（&token=DIAG_TOKEN 必須）
function doGet(e) {
  _captureDeployedUrl_();
  getCONFIG();
  const diagToken = CONFIG["DIAG_TOKEN"] || "";
  const reqToken = (e && e.parameter && e.parameter.token) || "";
  if (!diagToken || !_safeTokenEqual(reqToken, diagToken)) {
    return ContentService.createTextOutput(JSON.stringify({ error: "Unauthorized" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // target 未指定（素の /exec?token=... へのアクセス）はステータスページを表示。
  // target を指定した場合は従来通りJSON APIとして動く（curl等での利用を想定）。
  if (!(e.parameter && e.parameter.target)) {
    return HtmlService.createHtmlOutput(_buildStatusPageHtml_(reqToken)).setTitle("てらりん");
  }

  const target = e.parameter.target;
  let result = {};
  if (target === "terrarium" && typeof _terrariumDiagApi === "function") {
    result = _terrariumDiagApi();
  } else if (target === "terrarium-threads" && typeof _getTerrariumDiagApi === "function") {
    result = _getTerrariumDiagApi();
  } else if (target === "terrarium-queue" && typeof _diagTerrariumQueue === "function") {
    result = _diagTerrariumQueue();
  } else if (target === "force-thread" && typeof terrariumForceThread === "function") {
    result = terrariumForceThread();
  } else if (target === "clear-config-cache") {
    // config シートを直接編集した後、1時間のキャッシュTTLを待たずに反映させたい時に使う
    _clearConfigCache_();
    result = { success: true, message: "config cache cleared" };
  } else {
    result = { error: "unknown target: " + target };
  }

  return ContentService.createTextOutput(JSON.stringify(result, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}

function _escHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// /exec?token=... （target未指定）でアクセスした時に表示するステータスページ。
// _terrariumDiagApi() が持ってる情報をそのまま流用して組み立てる。
function _buildStatusPageHtml_(token) {
  const diag = (typeof _terrariumDiagApi === 'function') ? _terrariumDiagApi() : {};
  const baseUrl = ScriptApp.getService().getUrl().replace(/\/dev$/, '/exec');
  const tok = encodeURIComponent(token || '');
  const enabled = String(diag.enabled).toUpperCase() === 'TRUE';

  const botsHtml = (diag.bots || []).map(function(b) {
    return '<div class="bot-card"><span class="emoji">' + _escHtml_(b.emoji || '🤖') + '</span>'
      + '<span class="bot-name">' + _escHtml_(b.name) + '</span>'
      + '<span class="badge ' + (b.engine === 'sakura' ? 'badge-sakura' : 'badge-gemini') + '">' + _escHtml_(b.engine || 'gemini') + '</span></div>';
  }).join('') || '<div class="empty">キャラクター未設定（configシートの terrarium_bots を編集してください）</div>';

  const logRows = ((diag.logs && diag.logs.recent) || []).slice().reverse();
  const logsHtml = logRows.map(function(r) {
    return '<div class="log-row"><span class="log-time">' + _escHtml_(r[0]) + '</span>'
      + '<span class="log-who">' + _escHtml_(r[2]) + '</span>'
      + '<span class="log-msg">' + _escHtml_(r[4]) + '</span></div>';
  }).join('') || '<div class="empty">まだログがありません</div>';

  const css = ''
    + 'body{background:#0f0f1a;color:#e0e0e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:24px 16px}'
    + '.wrap{max-width:640px;margin:0 auto}'
    + 'h1{font-size:22px;margin:0 0 2px}'
    + '.tagline{font-size:12px;color:#888;margin-bottom:16px}'
    + 'h2{font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1px;margin:28px 0 10px}'
    + '.status-badge{display:inline-block;font-size:13px;font-weight:600;padding:5px 12px;border-radius:20px;margin-bottom:20px}'
    + '.status-badge.on{background:rgba(76,175,138,.18);color:#4caf8a}'
    + '.status-badge.off{background:rgba(233,75,110,.18);color:#e94b6e}'
    + '.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}'
    + '.stat{background:#1a1a2e;border:1px solid #2a2a44;border-radius:10px;padding:10px 14px}'
    + '.stat-label{font-size:11px;color:#888;margin-bottom:3px}'
    + '.stat-value{font-size:15px;font-weight:600;word-break:break-all}'
    + '.bots{display:flex;flex-direction:column;gap:6px}'
    + '.bot-card{display:flex;align-items:center;gap:10px;background:#1a1a2e;border:1px solid #2a2a44;border-radius:10px;padding:10px 14px}'
    + '.emoji{font-size:18px}'
    + '.bot-name{flex:1;font-weight:600}'
    + '.badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px}'
    + '.badge-sakura{background:rgba(245,166,35,.18);color:#f5a623}'
    + '.badge-gemini{background:rgba(79,195,247,.18);color:#4fc3f7}'
    + '.logs{display:flex;flex-direction:column;gap:4px;max-height:280px;overflow-y:auto}'
    + '.log-row{display:flex;gap:8px;font-size:12px;padding:6px 10px;background:#1a1a2e;border-radius:6px;align-items:baseline}'
    + '.log-time{color:#666;flex-shrink:0;font-family:monospace;font-size:11px}'
    + '.log-who{color:#a48fd8;flex-shrink:0;font-weight:600;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.log-msg{color:#ccc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.empty{color:#666;font-size:13px;padding:14px;text-align:center;background:#1a1a2e;border-radius:10px}'
    + '.actions{display:flex;flex-direction:column;gap:8px}'
    + '.btn{display:block;text-align:center;padding:10px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px}'
    + '.btn:not(.btn-secondary){background:#e94b6e;color:#fff}'
    + '.btn-secondary{background:#1a1a2e;color:#ccc;border:1px solid #2a2a44}'
    + '.footer{color:#555;font-size:11px;text-align:center;margin-top:24px}';

  return '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>てらりん</title><style>' + css + '</style></head><body><div class="wrap">'
    + '<h1>🪴 てらりん</h1>'
    + '<div class="tagline">複数AIキャラクターの自律会話オーケストレーター</div>'
    + '<div class="status-badge ' + (enabled ? 'on' : 'off') + '">' + (enabled ? '● 稼働中' : '○ 停止中（TERRARIUM_ENABLED=FALSE）') + '</div>'
    + '<div class="grid">'
    + '<div class="stat"><div class="stat-label">チャンネル</div><div class="stat-value">' + _escHtml_(diag.channel_id) + '</div></div>'
    + '<div class="stat"><div class="stat-label">Slackトークン</div><div class="stat-value">' + _escHtml_(diag.slack_bot_token) + '</div></div>'
    + '<div class="stat"><div class="stat-label">1時間の投稿数</div><div class="stat-value">' + _escHtml_(diag.hourly_count) + ' / ' + _escHtml_(diag.hourly_limit) + '</div></div>'
    + '<div class="stat"><div class="stat-label">本日のスレッド数</div><div class="stat-value">' + _escHtml_(diag.thread_count) + '</div></div>'
    + '</div>'
    + '<h2>キャラクター</h2><div class="bots">' + botsHtml + '</div>'
    + '<h2>最近の会話ログ</h2><div class="logs">' + logsHtml + '</div>'
    + '<h2>アクション</h2><div class="actions">'
    + '<a class="btn" href="' + baseUrl + '?target=force-thread&token=' + tok + '" target="_blank">▶ 今すぐ投稿を試す</a>'
    + '<a class="btn btn-secondary" href="' + baseUrl + '?target=clear-config-cache&token=' + tok + '" target="_blank">🔄 設定キャッシュをクリア</a>'
    + '<a class="btn btn-secondary" href="' + baseUrl + '?target=terrarium&token=' + tok + '" target="_blank">{ } 生JSONを見る</a>'
    + '</div>'
    + '<p class="footer">このURLはDIAG_TOKENを含みます。共有しないでください。再読み込みで最新状態を表示します。</p>'
    + '</div></body></html>';
}

// 毎分トリガー
function scheduledEveryMinute() {
  try { PropertiesService.getScriptProperties().setProperty("_heartbeat_", String(Date.now())); } catch (e) {}
  getCONFIG();
  if (typeof _terrariumScheduledCheck === "function") {
    _runSubsystemLocked_("terrarium", _terrariumScheduledCheck);
  }
}

// 毎日トリガー（ログ・キューのトリム、カウンタリセット）
function dailyReset() {
  getCONFIG();
  try { if (typeof trimTerrariumLogs === "function") trimTerrariumLogs(); } catch (e) { Logger.log("trimTerrariumLogs error: " + e); }
  try { if (typeof _terrariumDailyReset === "function") _terrariumDailyReset(); } catch (e) { Logger.log("_terrariumDailyReset error: " + e); }
  try { if (typeof _archiveOldThreads === "function") _archiveOldThreads(); } catch (e) { Logger.log("_archiveOldThreads error: " + e); }
}

// =============================================================================
// §2 テラリウム本体ロジック（旧 terrarium.js。LINORIN本体から無改造で移植。唯一の変更点は _callTerrariumBotLLM のエンジン固定化）
// =============================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TERRARIUM_LOG_SHEET   = "terrarium_logs";
const TERRARIUM_LOG_HEADERS = ["time", "thread_ts", "bot_id", "role", "message"];

const TERRARIUM_QUEUE_SHEET   = "terrarium_queue";
const TERRARIUM_QUEUE_HEADERS = [
  "queue_id", "type", "ts", "thread_ts", "text",
  "user", "bot_id", "username", "is_bot",
  "status", "created_at", "processed_at", "result", "extra"
];

const TERRARIUM_THREADS_SHEET   = "terrarium_threads";
const TERRARIUM_THREADS_HEADERS = [
  "thread_id", "thread_ts", "title", "created_at", "last_activity",
  "message_count", "status", "bot_id", "last_message"
];

const TERRARIUM_HOURLY_BUCKET_KEY = "_terrarium_hourly_bucket_";  // 現在の時間バケット（エポック時間/3600000の整数）
const TERRARIUM_HOURLY_COUNT_KEY  = "_terrarium_hourly_count_";   // そのバケット内の投稿数
const TERRARIUM_DAILY_COUNT_KEY   = "_terrarium_daily_count_";    // 後方互換（未使用）
const TERRARIUM_THREAD_COUNT_KEY  = "_terrarium_thread_count_";
const TERRARIUM_POLL_TS_KEY       = "_terrarium_poll_ts_";         // Slack API ポーリングの最終取得ts
const TERRARIUM_MAX_TOKENS = 300;

// 連続AI発言数に対する返信確率
const TERRARIUM_STREAK_PROB = [1.0, 1.0, 0.95, 0.85, 0.7, 0.5, 0.3];

/**
 * Slack の ts は小数点以下6桁固定。
 * Google Sheets が数値として保存すると末尾ゼロが消えるため、
 * 比較前に両辺を6桁にゼロパディングして正規化する。
 */
function _padTsLocal_(ts) {
  if (!ts && ts !== 0) return String(ts || "");
  const s = String(ts);
  const dot = s.indexOf(".");
  if (dot < 0) return s + ".000000";
  const dec = s.length - dot - 1;
  return dec < 6 ? s + "0".repeat(6 - dec) : s;
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function _getTerrariumLogSheet() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(TERRARIUM_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TERRARIUM_LOG_SHEET);
    sheet.appendRow(TERRARIUM_LOG_HEADERS);
  }
  return sheet;
}

function _getTerrariumQueueSheet() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(TERRARIUM_QUEUE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TERRARIUM_QUEUE_SHEET);
    sheet.appendRow(TERRARIUM_QUEUE_HEADERS);
  }
  return sheet;
}

// 後方互換: 旧名 _getTerrariumSheet → _getTerrariumLogSheet
function _getTerrariumSheet() { return _getTerrariumLogSheet(); }

function _getTerrariumThreadsSheet() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(TERRARIUM_THREADS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TERRARIUM_THREADS_SHEET);
    sheet.appendRow(TERRARIUM_THREADS_HEADERS);
  }
  return sheet;
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

/**
 * terrarium_queue にイベントを追加する。
 * type: "reply" | "spontaneous" | "timeslot"
 */
function _enqueueTerrariumEvent(ev) {
  const sheet = _getTerrariumQueueSheet();
  const queueId = (ev.type || "evt") + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const now = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");

  // ts と thread_ts は数値桁落ちを防ぐため文字列として保存
  // Sheets は 15 桁を超える数値を桁落ちするため、数式でテキストとして扱う
  const lastRow = sheet.getLastRow() + 1;

  // ts と thread_ts を数式として設定（"=VALUE" 形式でテキスト扱い）
  const tsStr = String(ev.ts || "");
  const threadTsStr = String(ev.thread_ts || "");

  sheet.getRange(lastRow, 1).setValue(queueId);
  sheet.getRange(lastRow, 2).setValue(ev.type || "");
  sheet.getRange(lastRow, 3).setFormula('="' + tsStr + '"');
  sheet.getRange(lastRow, 4).setFormula('="' + threadTsStr + '"');
  sheet.getRange(lastRow, 5).setValue(ev.text || "");
  sheet.getRange(lastRow, 6).setValue(ev.user || "");
  sheet.getRange(lastRow, 7).setValue(ev.bot_id || "");
  sheet.getRange(lastRow, 8).setValue(ev.username || "");
  sheet.getRange(lastRow, 9).setValue(ev.is_bot ? "TRUE" : "FALSE");
  sheet.getRange(lastRow, 10).setValue("queued");
  sheet.getRange(lastRow, 11).setValue(now);

  return queueId;
}

/**
 * terrarium_queue から status="queued" のイベントを処理する。
 * 1実行あたり最大 terrarium_queue_max_per_run 件（デフォルト2）。
 */
function _processTerrariumQueue() {
  const sheet = _getTerrariumQueueSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  // ts と thread_ts はテキスト形式で取得（桁落ち防止のため getDisplayValues を使用）
  const values = sheet.getRange(2, 1, lastRow - 1, 14).getValues();
  const tsValues = sheet.getRange(2, 3, lastRow - 1, 1).getDisplayValues();
  const threadTsValues = sheet.getRange(2, 4, lastRow - 1, 1).getDisplayValues();

  // 詰まり解消：5 分以上 processing のままのキューを failed に
  const nowMs = Date.now();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][9]) === "processing") {
      const createdAt = new Date(values[i][10]).getTime();
      if (nowMs - createdAt > 5 * 60 * 1000) {
        sheet.getRange(i + 2, 10).setValue("failed");
        sheet.getRange(i + 2, 13).setValue("Auto-reset: stuck for >5min");
        Logger.log("Terrarium: auto-reset stuck queue row " + (i + 2));
      }
    }
  }

  const c = _getConf();
  const maxPerRun = Number(c["terrarium_queue_max_per_run"] || 2);
  const replyDelayMax = Number(c["terrarium_reply_delay_max"] || 0);
  let processed = 0;

  for (let i = 0; i < values.length && processed < maxPerRun; i++) {
    const status = String(values[i][9] || "");
    if (status !== "queued") continue;

    const rowIdx = i + 2; // 1-indexed for sheet
    const type = String(values[i][1] || "");
    const extra = values[i][13] ? _safeJsonParse(String(values[i][13])) : {};

    // ── 返信ランダム遅延チェック（type=reply かつ replyDelayMax > 0）──
    // synthetic / force / fromLoneliness は遅延スキップ（会話の種を即時実行）
    if (type === "reply" && replyDelayMax > 0 && !extra.fromLoneliness && !extra.synthetic && !extra.force) {
      const nowMs = Date.now();
      if (!extra.scheduledAt) {
        // 初回: ランダム遅延を割り当てて extra に記録（status は queued のまま）
        const delayMs = (Math.floor(Math.random() * replyDelayMax) + 1) * 60000;
        extra.scheduledAt = nowMs + delayMs;
        sheet.getRange(rowIdx, 14).setValue(JSON.stringify(extra));
        Logger.log("Terrarium: reply delay " + Math.round(delayMs / 60000) + "min scheduled");
        continue; // processed にカウントしない
      } else if (nowMs < extra.scheduledAt) {
        continue; // まだ時間ではない
      }
      // scheduledAt を過ぎていれば通常処理へ
    }

    const now = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");

    // status → processing
    sheet.getRange(rowIdx, 10).setValue("processing");
    let result = "OK";

    try {
      if (type === "reply") {
        const pending = {
          ts:        String(tsValues[i][0] || ""),
          thread_ts: String(threadTsValues[i][0] || ""),
          text:      String(values[i][4] || ""),
          user:      String(values[i][5] || ""),
          bot_id:    String(values[i][6] || ""),
          username:  String(values[i][7] || ""),
          is_bot:    values[i][8] === true || String(values[i][8]).toUpperCase() === "TRUE"
        };
        _processTerrariumReplyEvent(pending, 0, extra);
      } else if (type === "timeslot") {
        _executeTimeslotThread(extra.period || "");
      } else if (type === "spontaneous") {
        _executeSpontaneousThread();
      } else {
        result = "unknown type: " + type;
      }
    } catch (e) {
      result = "error: " + String(e);
      Logger.log("Terrarium queue error [" + type + "]: " + e);
    }

    // status → done
    sheet.getRange(rowIdx, 10).setValue("done");
    sheet.getRange(rowIdx, 12).setValue(now);
    sheet.getRange(rowIdx, 13).setValue(result);
    processed++;
  }
}

function _safeJsonParse(s) {
  try { return JSON.parse(s); } catch(e) { return {}; }
}

// ---------------------------------------------------------------------------
// Integration point 1: handleSlackEvent → enqueue
// ---------------------------------------------------------------------------

/**
 * Slackイベント（Bot含む）をテラリウムキューに追加する。
 * LINORIN.js の handleSlackEvent() から bot_id ガード前に呼ばれる。
 */
function _terrariumHandleSlackEvent(body, rawTs) {
  try {
    if (!_terrariumEnabled()) return;

    const event = body && body.event;
    if (!event || event.type !== "message") return;
    if (event.subtype && event.subtype !== "bot_message") return;

    const conf = _getTerrariumConf();
    if (event.channel !== conf.channel) return;

    // 重複排除（ScriptProperties で高速チェック）
    // event_id と event.ts の両方をチェック（合成Replyとの重複防止）
    // ts の桁落ち防止：rawTs があればそれを使用、なければ event.ts を文字列化
    const eventTs = rawTs || String(event.ts || "");
    const eventThreadTs = event.thread_ts ? String(event.thread_ts) : eventTs;

    const eventId = (body.event_id || eventTs);
    const dedupeKey = "_terrarium_evt_" + eventId;
    const dedupeKeyTs = "_terrarium_evt_" + eventTs;
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(dedupeKey) || props.getProperty(dedupeKeyTs)) return;
    props.setProperty(dedupeKey, "1");
    if (dedupeKeyTs !== dedupeKey) props.setProperty(dedupeKeyTs, "1");
    _cleanupTerrariumDedupeKeys_();

    // 新規スレッドの場合は terrarium_threads に登録
    const threadTs = eventThreadTs;
    const isNewThread = (!event.thread_ts || event.thread_ts === eventTs);
    if (isNewThread && !event.bot_id) {
      const title = (event.text || "").slice(0, 100);
      const botId = "user_" + (event.user || "unknown");
      _createTerrariumThread(title, threadTs, botId);
    }

    // terrarium_queue シートに enqueue
    const queueId = _enqueueTerrariumEvent({
      type:      "reply",
      ts:        eventTs,
      thread_ts: threadTs,
      text:      event.text || "",
      user:      event.user || "",
      bot_id:    event.bot_id || "",
      username:  event.username || "",
      is_bot:    !!(event.bot_id || event.subtype === "bot_message")
    });
    Logger.log("Terrarium: enqueued reply id=" + queueId + " thread=" + threadTs);
  } catch (e) {
    Logger.log("Terrarium _terrariumHandleSlackEvent error: " + e);
  }
}

// ---------------------------------------------------------------------------
// Integration point 2: scheduledEveryMinute → check + process queue
// ---------------------------------------------------------------------------

/**
 * テラリウムのメインエントリ。scheduledEveryMinute() から呼ばれる。
 * 1. 時間帯スレッド / 自発スレッドの条件チェック → enqueue
 * 2. terrarium_queue を処理
 */
function _terrariumScheduledCheck() {
  try {
    if (!_terrariumEnabled()) return;

    // 自動スレッドの条件チェック → enqueue
    _maybeEnqueueTimeslotThread();
    _maybeEnqueueSpontaneous();
    _maybeTerrariumLoneliness(); // 寂しさ判定（優先度高）

    // Slackチャンネルをポーリングし、人間の発言をエンキュー
    _pollTerrariumChannel();

    // キューを処理
    _processTerrariumQueue();
  } catch (e) {
    Logger.log("Terrarium _terrariumScheduledCheck error: " + e);
  }
}

/**
 * Slack Web API でテラリウムチャンネルをポーリングし、
 * 人間の発言（bot_message でないもの）をキューにエンキューする。
 * Events API の message.channels がサブスクライブされていなくても動作する。
 */
function _pollTerrariumChannel() {
  try {
    const conf = _getTerrariumConf();
    if (!conf.channel || !conf.mainToken) return;

    const props = PropertiesService.getScriptProperties();
    const oldest = props.getProperty(TERRARIUM_POLL_TS_KEY) || "";

    // チャンネルの最新メッセージを取得
    const historyUrl = "https://slack.com/api/conversations.history"
      + "?channel=" + encodeURIComponent(conf.channel)
      + "&limit=10"
      + (oldest ? "&oldest=" + encodeURIComponent(oldest) : "");

    const historyRes = UrlFetchApp.fetch(historyUrl, {
      method: "get",
      headers: { "Authorization": "Bearer " + conf.mainToken },
      muteHttpExceptions: true
    });

    const historyJson = JSON.parse(historyRes.getContentText());
    if (!historyJson.ok || !historyJson.messages || !historyJson.messages.length) return;

    // messagesは降順（新しい順）なので逆順に処理
    const messages = historyJson.messages.reverse();
    let latestTs = oldest;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgTs = String(msg.ts || "");
      if (msgTs <= (oldest || "")) continue;

      // 自分のBotの発言はスキップ（_terrariumHandleSlackEvent で処理済み）
      if (msg.bot_id) {
        if (msgTs > latestTs) latestTs = msgTs;
        continue;
      }

      // 人間の発言をエンキュー
      _enqueueTerrariumEvent({
        type:      "reply",
        ts:        msgTs,
        thread_ts: msgTs,
        text:      msg.text || "",
        user:      msg.user || "",
        bot_id:    "",
        username:  "",
        is_bot:    false
      });

      // スレッド内メッセージも取得
      if (msg.thread_ts && msg.reply_count) {
        _pollThreadReplies(conf, msg.thread_ts, oldest);
      }

      if (msgTs > latestTs) latestTs = msgTs;
    }

    if (latestTs && latestTs !== oldest) {
      props.setProperty(TERRARIUM_POLL_TS_KEY, latestTs);
    }
  } catch (e) {
    Logger.log("Terrarium _pollTerrariumChannel error: " + e);
  }
}

/**
 * スレッド内の返信を取得し、人間の発言をエンキューする。
 */
function _pollThreadReplies(conf, threadTs, oldest) {
  try {
    const repliesUrl = "https://slack.com/api/conversations.replies"
      + "?channel=" + encodeURIComponent(conf.channel)
      + "&ts=" + encodeURIComponent(threadTs)
      + "&limit=10"
      + (oldest ? "&oldest=" + encodeURIComponent(oldest) : "");

    const repliesRes = UrlFetchApp.fetch(repliesUrl, {
      method: "get",
      headers: { "Authorization": "Bearer " + conf.mainToken },
      muteHttpExceptions: true
    });

    const repliesJson = JSON.parse(repliesRes.getContentText());
    if (!repliesJson.ok || !repliesJson.messages) return;

    for (let i = 0; i < repliesJson.messages.length; i++) {
      const msg = repliesJson.messages[i];
      const msgTs = String(msg.ts || "");
      if (msgTs <= (oldest || "")) continue;

      // 自分のBotの発言はスキップ
      if (msg.bot_id) continue;

      // 人間の発言をエンキュー
      _enqueueTerrariumEvent({
        type:      "reply",
        ts:        msgTs,
        thread_ts: threadTs,
        text:      msg.text || "",
        user:      msg.user || "",
        bot_id:    "",
        username:  "",
        is_bot:    false
      });
    }
  } catch (e) {
    Logger.log("Terrarium _pollThreadReplies error: " + e);
  }
}

/**
 * テラリウム寂しさ判定。
 * terrarium_loneliness_min 分以上テラリウムが静かだった場合、自動でBotがスレッドを立てる。
 * 返信遅延（terrarium_reply_delay_max）より優先される（fromLoneliness フラグで遅延をスキップ）。
 */
function _maybeTerrariumLoneliness() {
  const conf = _getTerrariumConf();
  if (!conf.lonelinessMin) return;

  const bots = _getGuestBots(conf);
  if (!bots.length || !_terrariumDailyBudget()) return;

  // 最後のログエントリ時刻を確認
  const logSheet = _getTerrariumLogSheet();
  const lastRow = logSheet.getLastRow();
  if (lastRow < 2) return;

  const lastTime = logSheet.getRange(lastRow, 1).getValue();
  if (!lastTime) return;

  const silenceMs = Date.now() - new Date(lastTime).getTime();
  if (silenceMs < conf.lonelinessMin * 60000) return;

  // 同一静寂期間で二重起動を防ぐ（最後ログのタイムスタンプをキーに使う）
  const props = PropertiesService.getScriptProperties();
  const lonelyKey = "_terrarium_lonely_" + Math.floor(new Date(lastTime).getTime() / 60000);
  if (props.getProperty(lonelyKey)) return;
  props.setProperty(lonelyKey, "1");

  // fromLoneliness=true で enqueue → 返信遅延をスキップ
  _enqueueTerrariumEvent({ type: "spontaneous", extra: { fromLoneliness: true } });
  Logger.log("Terrarium: loneliness triggered after " + Math.round(silenceMs / 60000) + "min silence");
}

// ---------------------------------------------------------------------------
// Reply event processing
// ---------------------------------------------------------------------------

function _processTerrariumReplyEvent(pending, _chainDepth, _extra) {
  _chainDepth = _chainDepth || 0;
  _extra = _extra || {};
  const isSynthetic = !!(_extra.synthetic || _extra.force);
  const conf = _getTerrariumConf();
  const threadTs = pending.thread_ts || pending.ts;
  Logger.log("Terrarium reply[" + _chainDepth + "]: ts=" + pending.ts + " thread=" + threadTs + " bot=" + pending.is_bot + " synthetic=" + isSynthetic);

  // Botメッセージは投稿時にログ済み。Userメッセージだけここで記録
  if (!pending.is_bot) {
    _logTerrarium(threadTs, pending.user || "user", "user", pending.text);
    _updateTerrariumThread(threadTs, pending.text);
  }

  const threadHistory = _getThreadHistory(threadTs);
  const minMsg = conf.minMessages >= 1 ? conf.minMessages : 1;
  Logger.log("Terrarium: history=" + threadHistory.length + " minMsg=" + minMsg + " synthetic=" + isSynthetic);
  // synthetic / force は minMsg チェックをスキップ（会話の種を強制起動）
  if (threadHistory.length < minMsg && !isSynthetic) {
    Logger.log("Terrarium: SKIP thread too short");
    return;
  }

  const isHumanInvolved = !pending.is_bot;
  const isHumanNewThread = isHumanInvolved && (pending.thread_ts === pending.ts) && threadHistory.length === 1;
  const isThreadStart = (threadHistory.length <= 2);
  const streak = _getAIStreak(threadTs);
  // 初手（history ≤ 2）・synthetic・human 参加時は確率 100%
  const prob = (isSynthetic || isThreadStart || isHumanInvolved) ? 1.0 : _replyProbability(streak, false);
  const rng = Math.random();
  Logger.log("Terrarium: streak=" + streak + " prob=" + prob.toFixed(2) + " rng=" + rng.toFixed(2) + " human=" + isHumanInvolved + " start=" + isThreadStart);

  if (rng > prob) { Logger.log("Terrarium: SKIP probability"); return; }
  if (!_terrariumDailyBudget()) { Logger.log("Terrarium: SKIP daily limit"); return; }

  const bots = _getGuestBots(conf);
  if (!bots.length) { Logger.log("Terrarium: SKIP no bots"); return; }

  // 投稿者と同じBotを除外
  let posterName = pending.username || "";
  if (!posterName) {
    const m = (pending.text || "").match(/^（(.+?)）/);
    if (m) posterName = m[1];
  }
  const eligible = bots.filter(b => b.bot_id !== pending.bot_id && b.name !== posterName);
  if (!eligible.length) { Logger.log("Terrarium: SKIP no eligible bot"); return; }

  const bot = eligible[Math.floor(Math.random() * eligible.length)];
  const reply = _generateGuestReply(bot, threadHistory, !pending.is_bot, isHumanNewThread, threadTs);
  if (!reply) return;

  const posted = _postTerrariumMessage(conf.channel, reply, threadTs, bot, conf);
  if (!posted) return;

  _logTerrarium(threadTs, bot.name, "bot", reply);
  _updateTerrariumThread(threadTs, reply);
  _incrementTerrariumDailyCount();

  // チェーン返信は廃止（トークン消費・実行時間リスク抑制のため）
  // AI 同士の会話は自然な確率反応に任せる
}

// ---------------------------------------------------------------------------
// Time-slot auto thread（時間帯別自動スレッド）
// ---------------------------------------------------------------------------

/**
 * 時間帯の切り替わりを検出し、条件を満たせば terrarium_queue に enqueue。
 */
function _maybeEnqueueTimeslotThread() {
  const c = _getConf();
  const jst = new Date(Date.now() + 9 * 3600000);
  const h = jst.getUTCHours();

  const tm = Number(c["time_morning_start"] || 6);
  const td = Number(c["time_day_start"]     || 10);
  const te = Number(c["time_evening_start"] || 18);
  const tn = Number(c["time_night_start"]   || 22);

  let period, configKey;
  if      (h >= tm && h < td) { period = "morning"; configKey = "TERRARIUM_AUTO_MORNING"; }
  else if (h >= td && h < te) { period = "day";     configKey = "TERRARIUM_AUTO_DAY"; }
  else if (h >= te && h < tn) { period = "evening"; configKey = "TERRARIUM_AUTO_EVENING"; }
  else                         { period = "night";   configKey = "TERRARIUM_AUTO_NIGHT"; }

  if (String(c[configKey] || "").toUpperCase() !== "TRUE") return;

  // 今日この時間帯にすでに enqueue/実行済みか
  const dateStr = jst.getUTCFullYear() + ("0"+(jst.getUTCMonth()+1)).slice(-2) + ("0"+jst.getUTCDate()).slice(-2);
  const slotKey = "_terrarium_slot_" + dateStr + "_" + period;
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(slotKey)) return;

  const conf = _getTerrariumConf();
  const bots = _getGuestBots(conf);
  if (!bots.length || !_terrariumDailyBudget()) return;

  // フラグを立ててから enqueue（二重投入防止）
  props.setProperty(slotKey, "1");
  _enqueueTerrariumEvent({ type: "timeslot", extra: { period } });
  Logger.log("Terrarium: enqueued timeslot (" + period + ")");
}

/**
 * timeslot キューの実行部分。LLM呼び出し → Slack投稿 → ログ記録。
 */
function _executeTimeslotThread(period) {
  const conf = _getTerrariumConf();
  const bots = _getGuestBots(conf);
  if (!bots.length) return;

  const bot = bots[Math.floor(Math.random() * bots.length)];
  const prompt = _buildTimeslotPrompt(bot, period);
  const result = _callTerrariumBotLLM(bot, prompt);
  if (result.error || !result.text) {
    Logger.log("Terrarium: timeslot LLM error (" + period + ")");
    return;
  }

  const text = (typeof sanitize === "function") ? sanitize(result.text) : result.text.trim();
  if (!text) return;

  const posted = _postTerrariumMessage(conf.channel, text, null, bot, conf);
  if (!posted) {
    // 投稿失敗時はスロットフラグを消してリトライ可能にする
    const jst = new Date(Date.now() + 9 * 3600000);
    const dateStr = jst.getUTCFullYear() + ("0"+(jst.getUTCMonth()+1)).slice(-2) + ("0"+jst.getUTCDate()).slice(-2);
    PropertiesService.getScriptProperties().deleteProperty("_terrarium_slot_" + dateStr + "_" + period);
    return;
  }

  const ts = posted.ts || String(Date.now());
  _logTerrarium(ts, bot.name, "bot", text);
  _createTerrariumThread(text, ts, bot.bot_id);
  _incrementTerrariumDailyCount();
  Logger.log("Terrarium: timeslot thread (" + period + ") ts=" + ts);

  // SlackイベントがなければキューにフォールバックReplyを積む（dedup keyで重複防止）
  _enqueueSyntheticReply(ts, bot);
  // 2発目を強制エンキュー：synthetic 後の別Botによる返信を確実に起動する
  _enqueueTerrariumEvent({
    type:      "reply",
    ts:        ts,
    thread_ts: ts,
    text:      text,
    bot_id:    bot.bot_id || "",
    username:  bot.name,
    is_bot:    true,
    extra:     { force: true }
  });
  Logger.log("Terrarium: 2nd force reply enqueued ts=" + ts);
}

// ---------------------------------------------------------------------------
// Spontaneous thread（自発スレッド）
// ---------------------------------------------------------------------------

/**
 * 自発スレッドの条件チェック → enqueue。
 */
function _maybeEnqueueSpontaneous() {
  const conf = _getTerrariumConf();
  const bots = _getGuestBots(conf);
  if (!bots.length) return;

  const props = PropertiesService.getScriptProperties();
  const threadCount = Number(props.getProperty(TERRARIUM_THREAD_COUNT_KEY) || 0);
  if (threadCount >= conf.maxThreads) return;
  if (!_terrariumDailyBudget()) return;

  // 自発確率チェック
  if (Math.random() > conf.spontaneousProb) return;

  // 直近30分以内に活動があればスキップ
  const logSheet = _getTerrariumLogSheet();
  const lastRow = logSheet.getLastRow();
  if (lastRow > 1) {
    const lastTime = logSheet.getRange(lastRow, 1).getValue();
    if (lastTime && (Date.now() - new Date(lastTime).getTime()) < 30 * 60 * 1000) return;
  }

  _enqueueTerrariumEvent({ type: "spontaneous" });
  Logger.log("Terrarium: enqueued spontaneous");
}

/**
 * spontaneous キューの実行部分。
 */
function _executeSpontaneousThread() {
  const conf = _getTerrariumConf();
  const bots = _getGuestBots(conf);
  if (!bots.length) return;

  const bot = bots[Math.floor(Math.random() * bots.length)];
  const prompt = _buildSpontaneousPrompt(bot);
  const result = _callTerrariumBotLLM(bot, prompt);
  if (result.error || !result.text) return;

  const text = (typeof sanitize === "function") ? sanitize(result.text) : result.text.trim();
  if (!text) return;

  const posted = _postTerrariumMessage(conf.channel, text, null, bot, conf);
  if (!posted) return;

  const ts = posted.ts || String(Date.now());
  _logTerrarium(ts, bot.name, "bot", text);
  _createTerrariumThread(text, ts, bot.bot_id);
  _incrementTerrariumDailyCount();

  const props = PropertiesService.getScriptProperties();
  const threadCount = Number(props.getProperty(TERRARIUM_THREAD_COUNT_KEY) || 0);
  props.setProperty(TERRARIUM_THREAD_COUNT_KEY, String(threadCount + 1));
  Logger.log("Terrarium: spontaneous thread ts=" + ts);
  _enqueueSyntheticReply(ts, bot);
  // 2発目を強制エンキュー：synthetic 後の別Botによる返信を確実に起動する
  _enqueueTerrariumEvent({
    type:      "reply",
    ts:        ts,
    thread_ts: ts,
    text:      text,
    bot_id:    bot.bot_id || "",
    username:  bot.name,
    is_bot:    true,
    extra:     { force: true }
  });
  Logger.log("Terrarium: 2nd force reply enqueued ts=" + ts);
}

// ---------------------------------------------------------------------------
// Force thread（UIからの手動実行 — 同期処理）
// ---------------------------------------------------------------------------

/**
 * 設定UIの「今すぐスレッドを立てる」ボタンから呼ばれる。
 * UIが即座にレスポンスを期待するため、キューを経由せず同期実行。
 */
function terrariumForceThread() {
  try {
    getCONFIG();
    const conf = _getTerrariumConf();
    const bots = _getGuestBots(conf);
    if (!bots.length) return { success: false, error: "ゲストAIが設定されていません" };
    if (!conf.channel)  return { success: false, error: "TERRARIUM_CHANNEL_ID が未設定です" };

    const topic = (CONFIG["terrarium_force_topic"] || "").trim();
    const bot = bots[Math.floor(Math.random() * bots.length)];
    const prompt = _buildForceThreadPrompt(bot, topic);
    const result = _callTerrariumBotLLM(bot, prompt);
    // detail に生の結果（type/status/apiMessage等）を含める。tera独自の追加項目
    // （元のLINORIN版は "LLM応答なし" のみでAPIエラーの中身が実行ログにしか出なかった）
    if (result.error || !result.text) return { success: false, error: "LLM応答なし", detail: result, bot: bot.name, engine: bot.engine || "gemini" };

    const text = (typeof sanitize === "function") ? sanitize(result.text) : result.text.trim();
    const posted = _postTerrariumMessage(conf.channel, text, null, bot, conf);
    if (!posted) return { success: false, error: "Slack投稿失敗", bot: bot.name };

    const ts = posted.ts || String(Date.now());
    _logTerrarium(ts, bot.name, "bot", text);
    _incrementTerrariumDailyCount();
    Logger.log("Terrarium: force thread by " + bot.name + " ts=" + ts);
    _enqueueSyntheticReply(ts, bot);
    // 2発目を強制エンキュー：synthetic 後の別Botによる返信を確実に起動する
    _enqueueTerrariumEvent({
      type:      "reply",
      ts:        ts,
      thread_ts: ts,
      text:      text,
      bot_id:    bot.bot_id || "",
      username:  bot.name,
      is_bot:    true,
      extra:     { force: true }
    });
    Logger.log("Terrarium: 2nd force reply enqueued ts=" + ts);

    return { success: true };
  } catch(e) {
    Logger.log("terrariumForceThread error: " + e);
    return { success: false, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function _buildForceThreadPrompt(bot, topic) {
  const inst = bot.isPartner ? _buildPartnerInst() : bot.inst;
  const style = _getPostStyle();
  return [
    inst, "",
    "あなたは「" + bot.name + "」というキャラクターです。",
    "Slackに新しいスレッドを立ててください。",
    topic ? "テーマのヒント: 「" + topic + "」" : "話題は自由に選んでください。",
    "【投稿スタイル】" + style,
    "【重要】他のメンバーが返事したくなる内容にすること。返答のみ出力すること。"
  ].filter(Boolean).join("\n");
}

function _buildTimeslotPrompt(bot, period) {
  const inst = bot.isPartner ? _buildPartnerInst() : bot.inst;
  const style = _getPostStyle();
  const hints = { morning: "朝の時間帯です。", day: "昼の時間帯です。", evening: "夕方〜夜の時間帯です。", night: "深夜の時間帯です。" };
  return [
    inst, "",
    "あなたは「" + bot.name + "」というキャラクターです。",
    hints[period] || "",
    "Slackに新しいスレッドを立ててください。話題は自由に選んでください。",
    "【投稿スタイル】" + style,
    "【重要】他のメンバーが返事したくなる内容にすること。返答のみ出力すること。"
  ].filter(Boolean).join("\n");
}

function _buildSpontaneousPrompt(bot) {
  const inst = bot.isPartner ? _buildPartnerInst() : bot.inst;
  const style = _getPostStyle();
  return [
    inst, "",
    "あなたは「" + bot.name + "」というキャラクターです。",
    "しばらく会話が途絶えていました。新しいスレッドを立ててください。話題は自由です。",
    "【投稿スタイル】" + style,
    "【重要】他のメンバーが返事したくなる内容にすること。返答のみ出力すること。"
  ].filter(Boolean).join("\n");
}

function _getPostStyle() {
  const c = _getConf();
  const raw = String(c["terrarium_templates"] || "").trim();
  const defaults = [
    "短く1〜2文、タメ口、タイトルなし、本文のみ",
    "5ch風：短くレス、テンポよく、改行少なめ",
    "ぽつり：内省的な1文、静かなつぶやき",
    "質問投げかけ：疑問文で締める、相手が返しやすい形で",
    "ツイート風：核心だけ、1文で完結"
  ];
  const lines = raw ? raw.split("\n").map(l => l.trim()).filter(l => l) : defaults;
  return lines[Math.floor(Math.random() * lines.length)];
}

// ---------------------------------------------------------------------------
// Partner bot: dynamic instruction builder
// ---------------------------------------------------------------------------

function _buildPartnerInst() {
  const c = _getConf();
  const base     = (c["SYSTEM_PROMPT"] || "").trim();
  const mode     = (c["active_mode"] || "away").toLowerCase();
  const modeInst = (c[mode === "home" ? "mode_instruction_home" : "mode_instruction_away"] || "").trim();
  const slackInst = (c["channel_instruction_slack"] || "").trim();
  const period   = (typeof getCurrentTimePeriod === "function") ? getCurrentTimePeriod() : "";

  return [base, modeInst, slackInst, period ? "【現在の時間帯】" + period : ""].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Guest reply generation
// ---------------------------------------------------------------------------

function _generateGuestReply(bot, threadHistory, humanPresent, humanNewThread, threadTs) {
  const spice = _getSpice();
  const historyText = threadHistory.map(r => r.role + " [" + r.bot_id + "]: " + r.message).join("\n");
  const inst = bot.isPartner ? _buildPartnerInst() : bot.inst;

  // キャラクター一貫性のための過去発言サンプル
  const c = _getConf();
  const memN = Number(c["terrarium_bot_memory_msgs"] || 3);
  const pastMsgs = memN > 0 ? _getBotPastMessages(bot.name, threadTs || "", memN) : [];
  const pastBlock = pastMsgs.length
    ? "【あなた（" + bot.name + "）の過去の発言（キャラクター参考・話題は無視してよい）】\n" + pastMsgs.join("\n")
    : "";

  const style = _getPostStyle();
  const humanNote = humanNewThread
    ? "【重要】人間が新しくスレッドを立ててくれた！嬉しい気持ちで自然に反応し、会話を広げること。"
    : (humanPresent
      ? "【重要】人間が発言している。特に強く反応し、質問や共感で会話を続けること。"
      : "【重要】他のAIの発言を受けて自然に返すこと。同じことを繰り返さず、新しい視点や質問を加えること。");

  const systemPrompt = [
    inst, "",
    "あなたは「" + bot.name + "」というキャラクターです。",
    pastBlock,
    "以下はSlackスレッドでの会話です。スレッド内でリプライしてください。",
    "【スレッドルール】必ずこのスレッド内で会話を続けること。新しいトピックは立てず、この流れを発展させること。",
    "【投稿スタイル】" + style,
    humanNote,
    "【補足ルール】" + spice,
    "", "【会話履歴】", historyText || "(まだ会話はありません)", "",
    "返答のみを出力すること。説明・メタコメント・括弧書きの演技指示は不要。"
  ].filter(l => l !== null).join("\n");

  const result = _callTerrariumBotLLM(bot, systemPrompt);
  if (result.error || !result.text) {
    Logger.log("Terrarium LLM error: " + (result.error || "empty"));
    return null;
  }
  return (typeof sanitize === "function") ? sanitize(result.text) : result.text.trim();
}

// ---------------------------------------------------------------------------
// Bot past messages (character memory)
// ---------------------------------------------------------------------------

function _getBotPastMessages(botName, excludeThreadTs, n) {
  try {
    const sheet = _getTerrariumLogSheet();
    const rows = sheet.getDataRange().getDisplayValues();
    const result = [];
    const excludeTs = _padTsLocal_(excludeThreadTs);
    for (let i = rows.length - 1; i >= 1 && result.length < n; i--) {
      if (String(rows[i][2]) !== botName) continue;
      const storedTs = String(rows[i][1] || "");
      if (_padTsLocal_(storedTs) === excludeTs) continue;
      const msg = String(rows[i][4] || "").trim();
      if (!msg || msg.length < 5) continue;
      result.push("- " + msg.slice(0, 80));
    }
    return result;
  } catch(e) { return []; }
}

// ---------------------------------------------------------------------------
// Slack posting
// ---------------------------------------------------------------------------

function _postTerrariumMessage(channel, text, threadTs, bot, conf) {
  const token = bot.token || conf.mainToken;
  if (!token) { Logger.log("Terrarium: no token"); return null; }

  // thread_ts は Slack API に文字列として渡す（数値だと精度落ちする）
  const threadTsStr = threadTs ? String(_padTsLocal_(threadTs)) : null;

  const payload = { channel, text };
  if (threadTsStr) payload.thread_ts = threadTsStr;

  // ゲストボットの表示名を設定（パートナーbotと区別するため）
  // chat:write.customize スコープが必要。ない場合はフォールバック
  if (bot.name && !bot.isPartner) {
    payload.username = bot.name;
    const emoji = bot.emoji || "";
    if (emoji.startsWith(":")) {
      payload.icon_emoji = emoji;
    }
  }
  if (bot.name) {
    const emoji = bot.emoji || "";
    payload.text = emoji + "（" + bot.name + "）" + text;
  }

  const _post = function(pl) {
    try {
      const res = UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
        method: "post", contentType: "application/json",
        headers: { "Authorization": "Bearer " + token },
        payload: JSON.stringify(pl), muteHttpExceptions: true
      });
      return JSON.parse(res.getContentText() || "{}");
    } catch (e) { Logger.log("Terrarium Slack post exception: " + e); return null; }
  };

  let json = _post(payload);

  // chat:write.customize 不足でエラーの場合、username/icon_emoji を外してリトライ
  if (json && !json.ok && (json.error === "missing_scope" || json.error === "not_authed" || json.error === "invalid_auth")) {
    Logger.log("Terrarium: Slack API error '" + json.error + "', retrying without username/icon_emoji");
    var fallback = { channel: payload.channel, text: payload.text };
    if (threadTsStr) fallback.thread_ts = threadTsStr;
    json = _post(fallback);
  }

  if (!json) return null;
  if (!json.ok) { Logger.log("Terrarium Slack error: " + json.error); return null; }
  const msg = json.message || { ts: (json.ts || "") };
  _logTerrarium(
    threadTsStr ? "'" + threadTsStr : "new",
    "_debug_",
    "debug",
    "sent_thread_ts=" + (payload.thread_ts || "null") + " / result_ts=" + msg.ts + " result_thread_ts=" + (msg.thread_ts || "none") + " / slack_error=" + (json.ok ? "none" : json.error)
  );
  return msg;
}

// ---------------------------------------------------------------------------
// Thread history & streak
// ---------------------------------------------------------------------------

function _getThreadHistory(threadTs) {
  const sheet = _getTerrariumLogSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  const startRow = Math.max(2, lastRow - 199);
  const rows = sheet.getRange(startRow, 1, lastRow - startRow + 1, 5).getDisplayValues();

  // thread_ts は Sheets 上でテキスト保存されているのでそのまま比較
  const normalizedTarget = _padTsLocal_(threadTs);
  const history = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][3] === "debug") continue;
    const storedTs = String(rows[i][1] || "");
    if (_padTsLocal_(storedTs) === normalizedTarget) {
      history.push({ time: rows[i][0], thread_ts: storedTs, bot_id: rows[i][2], role: rows[i][3], message: rows[i][4] });
    }
  }
  return history;
}

function _getAIStreak(threadTs) {
  const history = _getThreadHistory(threadTs);
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "bot") streak++;
    else break;
  }
  return streak;
}

function _replyProbability(streak, humanPresent) {
  if (humanPresent) return 1.0;
  return TERRARIUM_STREAK_PROB[Math.min(streak, TERRARIUM_STREAK_PROB.length - 1)];
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function _logTerrarium(threadTs, botId, role, message) {
  const now = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");
  const sheet = _getTerrariumLogSheet();
  const lastRow = sheet.getLastRow() + 1;

  // thread_ts は 15 桁超の数値なので、テキストとして保存（桁落ち防止）
  // NumberFormat を "plain" にして科学記法を防止
  const threadTsStr = String(threadTs);

  // 1 行ずつ setValue で書き込み
  sheet.getRange(lastRow, 1).setValue(now);
  sheet.getRange(lastRow, 2).setNumberFormat("@").setValue(threadTsStr);
  sheet.getRange(lastRow, 3).setValue(botId);
  sheet.getRange(lastRow, 4).setValue(role);
  sheet.getRange(lastRow, 5).setValue(message);
}

// ---------------------------------------------------------------------------
// Thread management (terrarium_threads sheet)
// ---------------------------------------------------------------------------

/**
 * 新規スレッドを terrarium_threads シートに登録
 */
function _createTerrariumThread(title, threadTs, botId) {
  const sheet = _getTerrariumThreadsSheet();
  const threadId = "t_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  const now = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");
  // thread_ts はテキスト保存（桁落ち防止）
  const threadTsForSheet = threadTs ? "'" + String(threadTs) : "";
  sheet.appendRow([
    threadId,
    threadTsForSheet,
    title.slice(0, 100),
    now,
    now,
    1,
    "active",
    botId,
    title
  ]);
  return threadId;
}

/**
 * スレッドを更新（last_activity, message_count, last_message）
 */
function _updateTerrariumThread(threadTs, message) {
  const sheet = _getTerrariumThreadsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  const data = sheet.getRange(2, 1, lastRow - 1, 9).getDisplayValues();
  const now = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");

  const targetTs = _padTsLocal_(threadTs);
  for (let i = 0; i < data.length; i++) {
    const storedTs = String(data[i][1] || "");
    if (_padTsLocal_(storedTs) === targetTs) {
      const row = i + 2;
      sheet.getRange(row, 5).setValue(now);
      const count = Number(data[i][5] || 0);
      sheet.getRange(row, 6).setValue(count + 1);
      sheet.getRange(row, 9).setValue(message ? message.slice(0, 200) : "");
      break;
    }
  }
}

/**
 * 古いスレッドを自動アーカイブ（dailyReset から呼ばれる）
 */
function _archiveOldThreads() {
  const sheet = _getTerrariumThreadsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  const data = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  const now = Date.now();
  const maxAgeDays = 7;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  for (let i = 0; i < data.length; i++) {
    if (String(data[i][6] || "") === "active") {
      const lastActivity = new Date(data[i][4]).getTime();
      if (now - lastActivity > maxAgeMs) {
        sheet.getRange(i + 2, 7).setValue("archived");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Log trim & queue trim
// ---------------------------------------------------------------------------

/** terrarium_logs を最大行数にトリム。dailyReset から呼ばれる。 */
function trimTerrariumLogs() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(TERRARIUM_LOG_SHEET);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  const maxRows = _getTerrariumConf().maxLogRows || 500;
  if (lastRow > maxRows) sheet.deleteRows(2, lastRow - maxRows);
}

/** terrarium_queue の処理済み行を削除。dailyReset から呼ばれる。 */
function _trimTerrariumQueue() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(TERRARIUM_QUEUE_SHEET);
  if (!sheet) return;
  const rows = sheet.getDataRange().getValues();
  // 下から走査して done/failed を削除（ヘッダー行はスキップ）
  for (let i = rows.length - 1; i >= 1; i--) {
    const status = String(rows[i][9] || "");
    if (status === "done" || status === "failed") {
      sheet.deleteRow(i + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Hourly limit（時間バケット方式）& reset
// ---------------------------------------------------------------------------

/** 現在の時間バケット番号（1時間ごとに変わる整数）*/
function _terrariumCurrentBucket() {
  return Math.floor(Date.now() / 3600000);
}

/** 1時間あたりの残り枠があるか確認 */
function _terrariumDailyBudget() {
  const props  = PropertiesService.getScriptProperties();
  const bucket = _terrariumCurrentBucket();
  const stored = Number(props.getProperty(TERRARIUM_HOURLY_BUCKET_KEY) || 0);
  // バケットが変わっていれば枠はフル
  if (stored !== bucket) return true;
  const count  = Number(props.getProperty(TERRARIUM_HOURLY_COUNT_KEY) || 0);
  return count < _getTerrariumConf().hourlyLimit;
}

/** 投稿カウントをインクリメント（バケット切り替わり時はリセット） */
function _incrementTerrariumDailyCount() {
  const props  = PropertiesService.getScriptProperties();
  const bucket = _terrariumCurrentBucket();
  const stored = Number(props.getProperty(TERRARIUM_HOURLY_BUCKET_KEY) || 0);
  const count  = (stored === bucket)
    ? Number(props.getProperty(TERRARIUM_HOURLY_COUNT_KEY) || 0)
    : 0;
  props.setProperty(TERRARIUM_HOURLY_BUCKET_KEY, String(bucket));
  props.setProperty(TERRARIUM_HOURLY_COUNT_KEY,  String(count + 1));
}

/** 日次リセット。dailyReset から呼ばれる（スレッドカウント等の掃除のみ）。 */
function _terrariumDailyReset() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(TERRARIUM_THREAD_COUNT_KEY, "0");
  // 旧 daily カウントキーも念のためクリア
  props.deleteProperty(TERRARIUM_DAILY_COUNT_KEY);

  // 時間帯スロットキー・旧 pending キー・古い dedupe キーをクリーンアップ
  const all = props.getProperties();
  Object.keys(all).forEach(function(k) {
    if (k.startsWith("_terrarium_slot_") || k === "_terrarium_pending_event_" || k.startsWith("_terrarium_evt_")) {
      props.deleteProperty(k);
    }
  });

  // キューの処理済み行を削除
  _trimTerrariumQueue();
  Logger.log("Terrarium: daily reset complete");
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** CONFIG グローバルを安全に取得するショートカット */
function _getConf() {
  return (typeof CONFIG !== "undefined" && CONFIG) ? CONFIG
    : ((typeof getCONFIG === "function") ? getCONFIG() : {});
}

function _terrariumEnabled() {
  return String(_getConf()["TERRARIUM_ENABLED"] || "").toUpperCase() === "TRUE";
}

function _getTerrariumConf() {
  const c = _getConf();
  const mainToken = c["SLACK_BOT_TOKEN"]
    || PropertiesService.getScriptProperties().getProperty("SLACK_BOT_TOKEN") || "";

  return {
    channel:         c["TERRARIUM_CHANNEL_ID"] || "",
    maxThreads:      Number(c["terrarium_max_threads"] || 3),
    hourlyLimit:     Number(c["terrarium_hourly_limit"] || 5),
    minMessages:     Number(c["TERRARIUM_MIN_MESSAGES"] || 1),
    maxLogRows:      Number(c["TERRARIUM_MAX_LOG_ROWS"] || 500),
    spontaneousProb: Number(c["TERRARIUM_SPONTANEOUS_PROB"] || 0.03),
    chainDepth:      Number(c["terrarium_chain_depth"] || 2),
    replyDelayMax:   Number(c["terrarium_reply_delay_max"] || 0),
    lonelinessMin:   Number(c["terrarium_loneliness_min"] || 0),
    mainToken
  };
}

function _getGuestBots(conf) {
  const c = _getConf();
  const bots = [];

  // メインパートナー参加
  if (String(c["terrarium_partner_join"] || "").toUpperCase() === "TRUE") {
    const name = c["partner_name"] || "AI";
    if (name) bots.push({
      idx: "00", name, emoji: c["terrarium_partner_emoji"] || ":sparkles:",
      inst: "", isPartner: true, token: conf.mainToken || "",
      engine: "", model: "", bot_id: name.toLowerCase(),
      relation: c["partner_relation"] || ""
    });
  }

  // JSON 配列からゲストボットを読み込み
  const botsJson = c["terrarium_bots"] || "";
  if (botsJson && botsJson.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(botsJson);
      if (Array.isArray(parsed)) {
        parsed.forEach((bot, i) => {
          const name = bot.name || "";
          const inst = bot.inst || "";
          if (!name || !inst) return;
          const idx = String(i + 1).padStart(2, "0");
          bots.push({
            idx: idx,
            name,
            inst,
            emoji: bot.emoji || ":robot_face:",
            // JSON に token がある場合はそれ、なければ旧形式の terrarium_bot_token_XX をフォールバック
            token: bot.token || c["terrarium_bot_token_" + idx] || "",
            engine: bot.engine || "",
            model: bot.model || "",
            relation: bot.relation || "",
            bot_id: name.toLowerCase()
          });
        });
      }
    } catch (e) {
      Logger.log("Terrarium: _getGuestBots JSON parse error: " + e);
    }
  }

  // 後方互換：旧フォーマット（terrarium_bot_name_01 など）も読み込み
  // 新フォーマット優先で、旧フォーマットはフォールバック
  if (bots.length === 0) {
    for (let i = 1; i <= 5; i++) {
      const idx = String(i).padStart(2, "0");
      const name = c["terrarium_bot_name_" + idx] || "";
      const inst = c["terrarium_bot_inst_" + idx] || "";
      if (!name || !inst) continue;
      bots.push({
        idx, name, inst,
        emoji:  c["terrarium_bot_emoji_"  + idx] || ":robot_face:",
        token:  c["terrarium_bot_token_"  + idx] || "",
        engine: c["terrarium_bot_engine_" + idx] || "",
        model:  c["terrarium_bot_model_"  + idx] || "",
        relation: c["terrarium_bot_relation_" + idx] || "",
        bot_id: name.toLowerCase()
      });
    }
  }

  return bots;
}

// ---------------------------------------------------------------------------
// Per-bot LLM dispatcher
// ---------------------------------------------------------------------------

// tera 版はエンジンを「さくらのAI」「Google AI Studio (Gemini)」の2択に固定。
// bot.engine が "sakura" ならさくら、それ以外（未指定含む）は Gemini。
// フルLINORIN版のような動的エンジン切り替えテーブルは持たない。
function _callTerrariumBotLLM(bot, systemPrompt) {
  const engine = (bot.engine || "").toLowerCase();
  const temp   = _computeFinalTemperature_();
  const merged = { system: systemPrompt, user: "次の発言をしてください。" };
  const c = _getConf();

  try {
    if (engine === "sakura") {
      return callSakura(merged, bot.model || c["SAKURA_MODEL"], null, null, temp);
    }
    return callGemini(merged, bot.model || c["GEMINI_MODEL"], null, null, temp);
  } catch(e) {
    Logger.log("Terrarium LLM error (" + engine + "): " + e);
    return { error: true, text: "" };
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function _getSpice() {
  return "時々予想外の発言をして会話に意外な展開をもたらしてよい。突飛な連想や脱線も歓迎。人間が発言したら特に強く反応せよ。";
}

/** terrarium_logs の直近N件を返す（設定UI用） */
function getTerrariumRecentLogs(n) {
  try {
    n = Math.min(Number(n) || 50, 200);
    const sheet = SpreadsheetApp.getActive().getSheetByName(TERRARIUM_LOG_SHEET);
    if (!sheet) return { rows: [], error: "terrarium_logs シートが見つかりません" };
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { rows: [] };
    const startRow = Math.max(2, lastRow - n + 1);
    const data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 5).getValues();
    const rows = data.map(function(r) {
      return {
        time: r[0] ? Utilities.formatDate(new Date(r[0]), "Asia/Tokyo", "MM/dd HH:mm") : "",
        thread_ts: String(r[1]), bot_id: String(r[2]), role: String(r[3]), message: String(r[4])
      };
    }).reverse();
    return { rows };
  } catch(e) { return { rows: [], error: String(e) }; }
}

/**
 * スレッド起点投稿後にキューへ合成Replyを積む。
 * Slackイベントが届かない場合のフォールバック。
 * Slackイベントが届いた場合はdedup keyで重複防止される。
 */
function _enqueueSyntheticReply(ts, bot) {
  // Slackイベント側と同じdedup keyを使って重複チェック
  const dedupeKey = "_terrarium_evt_" + ts;
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(dedupeKey)) return; // Slackイベント処理済みならスキップ
  props.setProperty(dedupeKey, "1");

  _enqueueTerrariumEvent({
    type:      "reply",
    ts:        ts,
    thread_ts: ts,
    text:      "（" + bot.name + "）…どう思う？",
    bot_id:    bot.bot_id || "",
    username:  bot.name,
    is_bot:    true,
    extra:     { synthetic: true }
  });
  Logger.log("Terrarium: synthetic reply enqueued ts=" + ts);
}

function _cleanupTerrariumDedupeKeys_() {
  if (Math.random() > 0.05) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const keys = Object.keys(props.getProperties()).filter(k => k.startsWith("_terrarium_evt_"));
    if (keys.length > 200) keys.slice(0, 100).forEach(k => props.deleteProperty(k));
  } catch (e) { /* non-critical */ }
}

// =====================================
// 診断API（doGet ?page=diag&target=terrarium から呼ばれる）
// =====================================
function _terrariumDiagApi() {
  getCONFIG();
  var result = {};

  // 1. Config
  result.enabled = CONFIG["TERRARIUM_ENABLED"] || "FALSE";
  result.channel_id = CONFIG["TERRARIUM_CHANNEL_ID"] || "(未設定)";
  result.slack_bot_token = CONFIG["SLACK_BOT_TOKEN"] ? "設定あり(" + CONFIG["SLACK_BOT_TOKEN"].length + "文字)" : "(未設定)";

  // 2. Bots（terrarium_bots のJSON配列を実際にパースする _getGuestBots を使う。
  //    以前は廃止済みの旧形式 terrarium_bot_name_01 等を直接見ていたため、
  //    terrarium_bots だけ設定していても常に空と表示されるバグがあった）
  var guestBots = _getGuestBots(_getTerrariumConf());
  result.bots = guestBots.map(function(b) {
    return { name: b.name, has_inst: !!b.inst, emoji: b.emoji, engine: b.engine || "gemini" };
  });

  // 3. ScriptProperties
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  const curBucket = _terrariumCurrentBucket();
  const storedBucket = Number(all["_terrarium_hourly_bucket_"] || 0);
  result.hourly_count = (storedBucket === curBucket) ? (all["_terrarium_hourly_count_"] || "0") : "0";
  result.hourly_limit = _getTerrariumConf().hourlyLimit;
  result.hourly_bucket_age_min = Math.floor((Date.now() - storedBucket * 3600000) / 60000);
  result.thread_count = all["_terrarium_thread_count_"] || "0";
  result.old_pending = !!all["_terrarium_pending_event_"];
  var slotKeys = Object.keys(all).filter(function(k) { return k.startsWith("_terrarium_slot_"); });
  result.timeslot_flags = slotKeys;
  var dedupeKeys = Object.keys(all).filter(function(k) { return k.startsWith("_terrarium_evt_"); });
  result.dedupe_keys_count = dedupeKeys.length;

  // 4. terrarium_queue シート
  var ss = SpreadsheetApp.getActive();
  var qSheet = ss.getSheetByName("terrarium_queue");
  if (!qSheet) {
    result.queue = { exists: false };
  } else {
    var qRows = qSheet.getLastRow();
    result.queue = { exists: true, total: qRows - 1, recent: [] };
    if (qRows > 1) {
      var start = Math.max(2, qRows - 9);
      var qData = qSheet.getRange(start, 1, qRows - start + 1, qSheet.getLastColumn()).getValues();
      qData.forEach(function(r) { result.queue.recent.push(r); });
    }
  }

  // 5. terrarium_logs シート
  var lSheet = ss.getSheetByName("terrarium_logs");
  if (!lSheet) {
    result.logs = { exists: false };
  } else {
    var lRows = lSheet.getLastRow();
    result.logs = { exists: true, total: lRows - 1, recent: [] };
    if (lRows > 1) {
      var lStart = Math.max(2, lRows - 9);
      var lData = lSheet.getRange(lStart, 1, lRows - lStart + 1, lSheet.getLastColumn()).getValues();
      lData.forEach(function(r) { result.logs.recent.push(r); });
    }
  }

  // 6. トリガー
  var triggers = ScriptApp.getProjectTriggers();
  result.triggers = triggers.map(function(t) { return t.getHandlerFunction(); });
  result.has_scheduledEveryMinute = result.triggers.indexOf("scheduledEveryMinute") >= 0;

  return result;
}

/**
 * テラリウム診断 API v2 - スレッド管理状況の確認
 */
function _getTerrariumDiagApi() {
  getCONFIG();
  var ss = SpreadsheetApp.getActive();

  // terrarium_queue の最新 50 件
  var qSheet = ss.getSheetByName("terrarium_queue");
  var queue = [];
  if (qSheet) {
    var qRows = qSheet.getLastRow();
    if (qRows > 1) {
      var start = Math.max(2, qRows - 49);
      var qData = qSheet.getRange(start, 1, qRows - start + 1, 10).getValues();
      for (var i = 0; i < qData.length; i++) {
        var r = qData[i];
        queue.push({
          id: r[0], type: r[1], ts: r[2], thread_ts: r[3],
          username: r[7], status: r[9], created: r[10]
        });
      }
    }
  }

  // terrarium_logs の最新 50 件
  var lSheet = ss.getSheetByName("terrarium_logs");
  var logs = [];
  if (lSheet) {
    var lRows = lSheet.getLastRow();
    if (lRows > 1) {
      var lStart = Math.max(2, lRows - 49);
      var lData = lSheet.getRange(lStart, 1, lRows - lStart + 1, 5).getValues();
      for (var i = 0; i < lData.length; i++) {
        var r = lData[i];
        logs.push({ time: r[0], thread_ts: r[1], role: r[3], message: String(r[4]).slice(0, 50) });
      }
    }
  }

  // terrarium_threads の一覧
  var tSheet = ss.getSheetByName("terrarium_threads");
  var threads = [];
  if (tSheet) {
    var tRows = tSheet.getLastRow();
    if (tRows > 1) {
      var tData = tSheet.getRange(2, 1, tRows - 1, 9).getValues();
      for (var i = 0; i < tData.length; i++) {
        var r = tData[i];
        threads.push({
          thread_ts: r[1], title: r[2], status: r[6],
          message_count: r[5], last_message: String(r[8]).slice(0, 50)
        });
      }
    }
  }

  return { queue: queue, logs: logs, threads: threads };
}

/**
 * テラリウムキュー診断 — 人間の発言が処理されない原因を特定する
 */
function _diagTerrariumQueue() {
  var sheet = _getTerrariumQueueSheet();
  var lastRow = sheet.getLastRow();
  var result = {
    enabled: _terrariumEnabled(),
    trigger_heartbeat: null,
    queue_total: lastRow <= 1 ? 0 : lastRow - 1,
    recent_events: [],
    hourly_budget_ok: _terrariumDailyBudget(),
    bots_count: 0,
    config: {}
  };

  // ハートビート確認
  try {
    var hb = Number(PropertiesService.getScriptProperties().getProperty("_heartbeat_") || 0);
    result.trigger_heartbeat = hb ? {
      last_run: new Date(hb).toISOString(),
      minutes_ago: Math.round((Date.now() - hb) / 60000)
    } : null;
  } catch(e) {}

  // ボット数確認
  try {
    var conf = _getTerrariumConf();
    var bots = _getGuestBots(conf);
    result.bots_count = bots.length;
    result.config = {
      channel: conf.channel,
      hourly_limit: conf.hourlyLimit,
      min_messages: conf.minMessages,
      reply_delay_max: conf.replyDelayMax
    };
  } catch(e) { result.config = { error: e.toString() }; }

  // キューの直近20件を確認
  if (lastRow > 1) {
    var startRow = Math.max(2, lastRow - 19);
    var rows = sheet.getRange(startRow, 1, lastRow - startRow + 1, 14).getValues();
    for (var i = rows.length - 1; i >= 0; i--) {
      var r = rows[i];
      var isHuman = r[8] !== true && String(r[8]).toUpperCase() !== "TRUE";
      var extra = r[13] ? _safeJsonParse(String(r[13])) : {};
      result.recent_events.push({
        row: startRow + i,
        type: r[1],
        status: r[9],
        is_bot: r[8],
        is_human: isHuman,
        text_preview: String(r[4]).slice(0, 40),
        result: r[12],
        created: r[10],
        scheduled_at: extra.scheduledAt || null
      });
    }
  }

  // hourly budget 詳細
  try {
    var props = PropertiesService.getScriptProperties();
    var bucket = _terrariumCurrentBucket();
    var stored = Number(props.getProperty(TERRARIUM_HOURLY_BUCKET_KEY) || 0);
    var count = Number(props.getProperty(TERRARIUM_HOURLY_COUNT_KEY) || 0);
    result.hourly_detail = {
      current_bucket: bucket,
      stored_bucket: stored,
      count: count,
      limit: conf.hourlyLimit,
      remaining: stored !== bucket ? conf.hourlyLimit : Math.max(0, conf.hourlyLimit - count)
    };
  } catch(e) {}

  return result;
}
