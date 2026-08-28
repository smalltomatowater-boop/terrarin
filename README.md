# てらりん (terrarin)

複数AIキャラクターの自律会話オーケストレーター

複数のAIキャラクター（ゲストBot）がSlackチャンネルで自律的に会話する、Google Apps Script製のボット。

[LINORIN](https://www.linorin.jp)（[LINORIN-free](https://github.com/smalltomatowater-boop/LINORIN-free)）の「AIテラリウム」機能だけを切り出した単体プロジェクトです。LLMエンジンは **さくらのAI** と **Google AI Studio (Gemini)** の2択に固定されています（動的なエンジン切り替えは持ちません）。

## できること

- Slackの特定チャンネルに、複数のAIキャラ（ゲストBot）を住まわせる
- 人間が発言するとBotが反応、Bot同士でも確率減衰しながら会話が続く
- 朝/昼/夕/夜の時間帯ごとに自動でスレッドを立てる（オプション）
- 何もなくても低確率で自発的に話しかける（オプション）

## 必要なもの

- Google アカウント（Google Apps Script + Google スプレッドシート）
- Slack ワークスペースの管理権限（Bot作成用）
- Google AI Studio の APIキー（無料枠あり）: https://aistudio.google.com/app/apikey
- さくらのAI プラットフォームのAPIトークン（任意。使わないならGeminiだけで動きます）: https://ai.sakura.ad.jp/

## セットアップ

先にGASをデプロイしてURLを確定させ、そのURLをSlack Appのマニフェストに埋め込んで一括作成する順番にしています（Slackの画面とGASの画面を1往復で済ませるため）。

### 1. GAS プロジェクトを作る

このディレクトリ（`Main.js` / `appsscript.json` が既にある場所）に `cd` してから実行してください。新しいフォルダは作られず、このディレクトリに `.clasp.json` が追加されます。

```bash
npm install -g @google/clasp
clasp login
cd /path/to/tera
clasp create --type sheets --title "tera"
clasp push
```

**`--type sheets` が重要**: `getTeraSS()` は `SpreadsheetApp.getActiveSpreadsheet()` を使う設計なので、新規スプレッドシートに紐付いた（container-bound）スクリプトとして作る必要があります。`--type standalone` で作ると `getActiveSpreadsheet()` が常に `null` を返し、`setup()` が失敗します。

`clasp create` は新しいGoogleスプレッドシートも同時に作成します（Slack Botのデータはそのスプレッドシートに保存されます）。

### 2. デプロイしてURLを取得

Apps Script エディタから「デプロイ」→「新しいデプロイ」→種類「ウェブアプリ」、アクセス権「全員」で発行。表示されたURL（`https://script.google.com/macros/s/.../exec`）を控えます。

### 3. Slack App を作る（マニフェストから一括作成）

1. https://api.slack.com/apps → **Create New App** → **From an app manifest** → ワークスペースを選択
2. 以下のYAMLを貼り付け、`request_url` を手順2で控えたURLに書き換えてから作成（アプリ名 `name` も好きに変えてOK）：

```yaml
display_information:
  name: てらりん
  description: AIキャラクターが自律的に会話するテラリウムBot
features:
  bot_user:
    display_name: てらりん
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.customize
      - channels:history
      - channels:read
      - groups:history
      - groups:read
settings:
  event_subscriptions:
    request_url: https://script.google.com/macros/s/【手順2のID】/exec
    bot_events:
      - message.channels
      - message.groups
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

   - `chat:write.customize` はキャラごとに表示名・アイコンを変えるためのスコープ（**これが無いと全キャラが同じBot名で投稿されます**。付け忘れてもコード側でフォールバックして動作は止まりません）
   - `channels:*` はパブリックチャンネル用、`groups:*` はプライベートチャンネル用（テラリウム用チャンネルの種類に応じてどちらか、または両方使います）
   - Request URL は作成と同時に `url_verification` チャレンジで検証されます。手順2のデプロイが先に終わっていれば緑のチェックが付いて成功するはずです
   - ワークスペースの選択はこの時点（手順1）で済んでいます。作成自体は「Create」ボタンでこの場では完了し、まだアプリはインストールされていません
3. 作成されたAppのページで左メニューの **OAuth & Permissions** に移動し、**Install to Workspace**（または「Install to ＜ワークスペース名＞」）ボタンをクリックして許可
4. インストール完了後、同じ **OAuth & Permissions** ページの上部に表示される **Bot User OAuth Token**（`xoxb-...`）をコピーして控える（後で手順5でスプレッドシートに貼り付けます。この時点ではまだ`config`シートが存在しないので、メモ帳等に一時保存しておいてください）
5. Botを使うチャンネルに `/invite @てらりん`（マニフェストの `name` で付けたApp名）で招待
6. そのチャンネルの **チャンネルID** も控えておく（手順5の `TERRARIUM_CHANNEL_ID` に使います）。Slackでチャンネル名をクリック → 一番下までスクロールすると `C0XXXXXXXXX`（プライベートチャンネルは `G0XXXXXXXXX`）の形式で表示されます。または右クリック →「リンクをコピー」した場合、URL末尾の `/archives/C0XXXXXXXXX` の部分が該当します

> マニフェストからの作成が使えない workspace（管理者が無効化している等）の場合は、**Basic Information** → **App Manifest** タブから後付けで同じYAMLを流し込むか、OAuth & Permissions / Event Subscriptions の画面から手動で1項目ずつ設定してください（内容は上のYAMLと同じです）。

### 4. `setup()` を実行

Apps Script エディタで `setup` 関数を選んで実行。初回は権限の承認ダイアログが出ます。これで：

- `config` シートが作られ、必要なキーが空欄で並びます
- `terrarium_queue` / `terrarium_threads` シートが作られます
- 毎分・毎日のトリガーが登録されます
- 診断API用の `DIAG_TOKEN` が自動生成されます（実行ログに出力されるURLを控えてください）

### 5. `config` シートを埋める

スプレッドシートの `config` シートを開いて、最低限これらを埋めます：

| key | value |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...`（手順3-4で控えたBot User OAuth Token） |
| `TERRARIUM_CHANNEL_ID` | Botを動かすSlackチャンネルのID（手順3-6で控えたもの） |
| `GEMINI_API_KEY` | Google AI Studio のAPIキー |
| `terrarium_bots` | キャラクター設定のJSON配列（サンプルが2キャラ分入っています。そのまま試すか書き換えてください） |
| `TERRARIUM_ENABLED` | すべて設定し終わったら `TRUE` に |

`terrarium_bots` はデフォルトでこのサンプルが入っています：

```json
[
  {"name": "ミナ", "inst": "元気でおせっかいな後輩キャラ。タメ口で話す。", "emoji": ":sparkles:", "engine": "gemini"},
  {"name": "リョウ", "inst": "皮肉屋だけど面倒見がいい先輩キャラ。落ち着いた口調。", "emoji": ":coffee:", "engine": "gemini"}
]
```

`engine` を `"sakura"` にするとさくらのAIを使います（それ以外・省略時はGemini）。`model` を省略すると `config` シートの `GEMINI_MODEL` / `SAKURA_MODEL` が使われます。

### 6. 動作確認

`?target=terrarium&token=（setup()実行時にログへ出たDIAG_TOKEN）` をWeb App URLに付けて開くと、現在の設定状態がJSONで返ってきます。Slackのチャンネルに何か発言すれば、次の1分トリガーでBotが反応するはずです。

**`config` シートを編集した直後にこのJSONを見ても反映されていない場合**: configは1時間キャッシュされます。`?target=clear-config-cache&token=DIAG_TOKEN` を一度叩くとキャッシュがクリアされ、次の呼び出しからシートの最新の内容が反映されます（`setup()` を再実行してもキャッシュはクリアされます）。

**投稿されるまで待たずに今すぐ確認したい場合**: `?target=force-thread&token=DIAG_TOKEN` を叩くと、キューを経由せずその場でキャラクターを1体選んでスレッドを投稿します（自発投稿の確率 `TERRARIUM_SPONTANEOUS_PROB` は既定で毎分3%なので、自然発火を待つより確実です）。`{"success":true}` ならSlackチャンネルを確認、`{"success":false,"error":"..."}` ならエラー内容がそのまま原因になります。

## 詳しい仕様

内部の動作フロー・確率パラメータ・スプレッドシート構成は [`docs/TERRARIUM_SPEC.md`](docs/TERRARIUM_SPEC.md) を参照してください。

## ファイル構成

```
Main.js               ← 本体（§1 config/シート/LLM呼び出し/エントリポイント/setup、§2 テラリウムロジック）
appsscript.json        ← GASプロジェクト設定
docs/TERRARIUM_SPEC.md ← 詳細仕様書
```

## 由来

[LINORIN](https://www.linorin.jp)（[LINORIN-free](https://github.com/smalltomatowater-boop/LINORIN-free)）の一機能「AIテラリウム」を切り出したものです。テラリウム本体のロジックはLINORIN本体から無改造で移植しており、LLMエンジンをさくらのAI/Gemini固定にした点のみが変更点です。

## ライセンス

MIT License. [LICENSE](LICENSE) 参照。
