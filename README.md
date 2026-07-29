# Motion Tagger (Figma Plugin)

Figma上のレイヤーにIDを割り当て、フェードイン/フェードアウト/ムーブ/サイズ変更のアニメーション(duration, delay, easing)を設定して、JSONとしてエクスポートするプラグインです。

## セットアップ

```bash
npm install
npm run build
```

## Figmaへの読み込み方

1. Figmaデスクトップアプリを開く
2. `Plugins` → `Development` → `Import plugin from manifest...`
3. このディレクトリの `manifest.json` を選択
4. `Plugins` → `Development` → `Motion Tagger` で起動

コードを変更した場合は `npm run watch` を実行しておくと、保存のたびに自動でビルドされます(Figma側は再度プラグインを開き直せば最新版が反映されます)。

## 使い方

1. Figma上でレイヤー(パーツ)を1つ選択
2. 「部品ID」は任意です。先に入力して「部品IDを追加」を押しても、何も押さずに直接手順3に進んでもかまいません。「アニメーション」パネルは常に操作可能で、初めてアニメーションを追加した時点でその時点の部品ID欄の値(空欄でも可)で自動的にタグが作成されます
3. 「アニメーション」パネルは「設定済みアニメーション」(一覧)と「アニメーションを追加」(入力フォーム)の2つの区切りセクションに分かれています。フォームで種類(フェードイン/フェードアウト/ムーブ/サイズ変更)・アニメID(任意)・Duration・Delay・Easingを設定し「+ アニメーションを追加」
   - アニメIDは要素のIDとは別の、アニメーション単位の任意ラベルです。一意である必要はなく、たとえば同じ性質のフェードインを複数要素に付ける際に共通のIDを使えます(例: 複数要素に`fade_standard`というIDのフェードインを設定)
   - ムーブは「指定方法」で2通り選べます(**デフォルトは絶対座標**)
     - **絶対座標**(デフォルト): X座標・Y座標それぞれについて「移動元 from」「移動先 to」の絶対座標(Figmaキャンバス上の座標)を個別に入力する4フィールド形式です。終点(to)を現在のレイヤー位置と異なる場所に指定することもできます。「種類」をムーブに切り替えた時、または選択レイヤーを切り替えた時に、選択中レイヤーの現在座標がfrom・to両方の初期値として自動入力されます(初期状態では移動なし。そこからfromやtoを調整してください)
     - **差分 (dx/dy)**: 「移動元 dx / dy」に、最終位置(現在のFigma上の座標)からどれだけずらした位置から動き始めるかのオフセットを入力します。例: `dx: -100` は現在位置より左100pxから右へスライドインする動き。終点(to)は常に現在のレイヤー位置になります。要素をまたいで同じ値を使い回したい場合に向いています(選択レイヤーを切り替えても値が保持されます)
   - サイズ変更も「指定方法」で2通り選べます(**デフォルトはパーセンテージ**)、ムーブと対になる設計です
     - **パーセンテージ**(デフォルト): X方向・Y方向それぞれに拡大率(%、100=変化なし)を入力します。例: `80` は現在サイズの80%から始まり、通常サイズ(100%)へ変化する動き。終了状態は常に現在のレイヤーサイズになります(Figma Motionの`SCALE_X`/`SCALE_Y`に対応)
     - **幅・高さ (from-to)**: 幅・高さそれぞれについて開始(from)・終了(to)のピクセル寸法を個別に入力します。終了サイズを現在のレイヤーサイズと異なる値にすることもできます(Figma Motionの`WIDTH`/`HEIGHT`に対応)。「種類」をサイズ変更に切り替えた時、または選択レイヤーを切り替えた時に、選択中レイヤーの現在の幅・高さがfrom・to両方の初期値として自動入力されます
   - 1つの要素に複数のアニメーションを追加できます(例: フェードイン + ムーブ)
   - Duration/Delay/Easing/アニメIDの入力欄は選択レイヤーを切り替えても保持されるため、同じ設定を複数要素へ連続して追加するのに便利です
   - 「設定済みアニメーション」の各行にある✎(編集)を押すと、そのアニメーションの内容がフォームに読み込まれ、「変更を保存」で上書きできます(「キャンセル」で編集を中断)。×は削除です。選択レイヤーを切り替えると編集は自動的にキャンセルされます
4. 「全アニメ一覧」タブには、タグ付けされた全要素・全アニメーションをまとめたJSON(エクスポートされる内容そのもの)が常に最新の状態でプレビュー表示されます。要素を追加・変更・削除するたびに自動的に更新されます
5. 「JSONをエクスポート」でそのJSONをファイルとしてダウンロード

アニメ設定はFigmaノードの `pluginData` に保存されるため、ファイルを保存・再読み込みしても保持されます。要素のIDは任意入力です(空欄可)。値を入力した場合のみドキュメント全体での一意性をチェックします(重複するとエラー表示)。空欄のまま保存した場合、複数の要素が空欄IDを持つことができ、JSON出力でも`"id": ""`として出力されます。

### 重複ID警告

プラグイン経由でのID保存には一意性チェックがありますが、それでも重複が発生し得る原因が2つあります。

1. **Figma上での複製**: タグ付き済みのレイヤーやフレームを複製(Duplicate/コピー&ペースト)、ページ複製、ブランチのマージなどを行うと、`pluginData`(部品ID・アニメーション設定)がそのままコピーされるため、プラグインのチェックを経由せずに同じIDを持つ要素が2つ以上できてしまいます。
2. **連続保存による競合状態(修正済み)**: `save-tag` / `save-animation` のID重複チェックはFigmaの複数ページを走査する非同期処理のため、間を置かず連続で(例: 要素Aに`test1`と入力して保存した直後に要素Bにも`test1`と入力して保存)保存すると、1回目の書き込みが完了する前に2回目のチェックが走り、両方とも「使用可能」と判定されて重複が生まれることがありました。`src/code.ts`に同期的なID予約(`reservedIds`/`tryClaimId`)を追加し、この競合を解消しています。

いずれの原因であっても、重複が発生すると「全アニメ一覧」タブのJSONプレビュー上部に警告バナーが表示され、重複しているIDとその該当レイヤー名・nodeIdが一覧表示されます。表示された情報を手がかりに、Figma上で該当レイヤーを探して「選択中」タブから部品IDを付け直してください(自動修正は行いません)。

### Figma Motionへの反映について(Beta)

- Figmaの「Motion」機能(2026年Config 2026で発表、Plugin APIは現在Beta)を使って実際にプレビューできるようにする連携です。**Smart Animate(プロトタイプのフレーム間遷移)とは別物**で、1つのフレーム内で個々のレイヤーを直接キーフレーム(位置・不透明度)アニメーションさせます。
- ボタン操作は不要で、常に自動で同期されます。「+ アニメーションを追加」を押した時点で、そのフレーム内のアニメ設定済み要素すべてがMotionの手動キーフレームトラック(`OPACITY` / `TRANSLATION_X` / `TRANSLATION_Y` / `SCALE_X` / `SCALE_Y` / `WIDTH` / `HEIGHT`)として書き込まれます。同様に、アニメーションを削除する(「削除」ボタン)、要素のアニメ設定ごと削除する(「アニメ削除」/全アニメ一覧の「削除」)と、対応するMotionのキーフレームトラックもその場で自動的に取り除かれます。
- フレームのMotionタイムライン全体の長さは、そのフレーム内で最も遅く終わるアニメーション(`delay + duration`の最大値)に自動調整されます。
- この同期は裏側のベストエフォート処理で、選択やビューポートは変化させず、失敗しても通知は表示しません(プラグイン内のアニメ設定自体は`pluginData`に常に正常に保存されるため、Motion連携が使えない環境でもプラグインの主要機能には影響しません)。
- Motion APIは執筆時点でBeta・機能フラグ(`metronome`)による段階的提供のため、**Figmaアカウント/ファイルによっては利用できない場合があります**。その場合、上記の同期は静かに何もしません(エラー表示なし)。
- 画面下部に表示されるFigma純正のMotionタイムラインパネルで再生・スクラブ確認ができ、必要であればそこからさらに手動で微調整も可能です。

## 出力JSONのスキーマ

```jsonc
{
  "version": 1,
  "generatedAt": "2026-07-29T00:00:00.000Z",
  "elements": [
    {
      "id": "hero_title",           // 割り当てたID
      "name": "Hero Title",         // Figmaレイヤー名
      "animations": [
        {
          "id": "fade_standard",    // アニメごとの任意ID。一意である必要はなく、同じ性質のアニメーション同士で共有してよい(未入力なら空文字)
          "type": "fadeIn",         // "fadeIn" | "fadeOut" | "move"
          "duration": 300,          // ms
          "delay": 0,               // ms
          "easing": "easeOut",      // プリセット名 or "cubic-bezier(x1,y1,x2,y2)"
          "bezier": [0, 0, 0.58, 1],// 常に解決済みの [x1,y1,x2,y2] を含む(CSS/Web Animations APIでそのまま使える)
          "opacity": { "from": 0, "to": 1 }
        },
        {
          "id": "",
          "type": "move",
          "duration": 400,
          "delay": 100,
          "easing": "easeOutCubic",
          "bezier": [0.215, 0.61, 0.355, 1],
          "position": {
            // どちらも絶対座標。"絶対座標"モードならfrom/toとも入力値をそのまま、
            // "差分"モードならfromは現在位置+dx/dyから算出、toは常に現在のFigma上の位置
            "from": { "x": 0, "y": 200 },
            "to":   { "x": 100, "y": 200 }
          }
        },
        {
          "id": "",
          "type": "resize",
          "duration": 400,
          "delay": 0,
          "easing": "easeOut",
          "bezier": [0, 0, 0.58, 1],
          // "パーセンテージ"モードの場合のみ。100 = 変化なし。toは常に100
          "scale": { "from": { "x": 80, "y": 80 }, "to": { "x": 100, "y": 100 } }
        },
        {
          "id": "",
          "type": "resize",
          "duration": 400,
          "delay": 0,
          "easing": "easeOut",
          "bezier": [0, 0, 0.58, 1],
          // "幅・高さ (from-to)"モードの場合のみ。ピクセル単位の絶対サイズ
          "size": { "from": { "width": 100, "height": 50 }, "to": { "width": 300, "height": 150 } }
        }
      ]
    }
  ]
}
```

`scale`と`size`は同時には出力されません(`resize`アニメーションの指定方法により、どちらか一方のみ)。

## 開発メモ

- `src/code.ts`: Figmaサンドボックス側(選択検知、pluginDataの読み書き、ドキュメント全体を走査してのJSON出力)。`sendExportPreview()`が`ui-ready`および各変更操作のたびに`buildExportJson()`の結果を`export-preview`メッセージとしてUIへ送り、ライブプレビューを実現しています
- ID一意性チェックは`isIdAvailable()`(非同期・複数ページ走査)を`tryClaimId()`でラップし、同一IDに対する同期的な予約(`reservedIds: Set<string>`)を行うことで、連続保存時のcheck-then-writeの競合状態を防いでいます
- `src/ui.ts` + `src/ui.template.html`: プラグインUI(バニラTS、フレームワーク不使用)
- `src/easing.ts`: easingプリセット名 ⇔ cubic-bezier変換(Figma Motionへの反映時は常に`CUSTOM_CUBIC_BEZIER`として渡しています)
- `build.js`: esbuildでcode.ts / ui.tsをそれぞれバンドルし、ui.jsをui.template.htmlにインライン埋め込みして `dist/ui.html` を生成
- `manifest.json` は `documentAccess: "dynamic-page"` を指定しているため、コード側は `figma.getNodeByIdAsync` / `figma.loadAllPagesAsync` などの非同期APIを使用しています
- Figma Motion連携は `applyMotionToFrame(nodeId)`(`src/code.ts`)で実装。`node.applyManualKeyframeTrack()` / `node.removeManualKeyframeTrack()` / `node.setTimelineDuration()` などの `MotionNodeMixin` API(`@figma/plugin-typings` v1.131.0で型定義済み)を使用。フレーム直下の最上位フレーム自体には直接キーフレームを設定できない(Motion APIの仕様)ため、フレーム自身がタグ付けされていてもトップレベルフレームなら自動的にスキップします
- `applyMotionToFrame`は毎回そのフレーム内の対象ノードすべてについてOPACITY/TRANSLATION_X/TRANSLATION_Y/SCALE_X/SCALE_Y/WIDTH/HEIGHTトラックを現在のタグデータから再計算し、キーフレームが無くなったプロパティは`node.manualKeyframeTracks`を見て既存トラックがあれば`removeManualKeyframeTrack`で削除します。これにより、プラグイン側でのアニメーション削除がMotion側にも反映されます。完全にベストエフォート・サイレント設計で、`save-animation` / `delete-animation` / `delete-tag` の各メッセージハンドラから自動的に呼ばれ、エラーは一切UIに表示しません(専用の確認ボタンは廃止し、常時自動同期のみとしています)
- `src/move.ts`: ムーブアニメーションの「絶対座標」/「差分(dx/dy)」2モードを扱う共通ロジック(`getEffectiveMoveMode` / `resolveMovePositions`)。`resolveMovePositions`はfrom/to両方の絶対座標を返します(差分モードではtoは常に現在位置)。`code.ts`(JSON出力・Motion反映の両方)から利用しており、以前はJSON出力側とMotion反映側で`dx`の符号の扱いが食い違っていたバグ(JSON出力側が`currentPos - dx`、Motion反映側が`dx`をそのまま使用していて逆符号だった)をこの一本化で修正しています。`AnimationSpec.moveMode`が未設定の場合は、モード切り替え機能導入前の既存データとして常に差分(delta)モード扱いにフォールバックします
- `src/resize.ts`: サイズ変更アニメーションの「パーセンテージ」/「幅・高さ(絶対値)」2モードを扱うモード判定ロジック(`getEffectiveResizeMode`)。moveとは異なり、パーセンテージモードはFigma Motionの`SCALE_X`/`SCALE_Y`(倍率、1.0が等倍)へ、絶対モードは`WIDTH`/`HEIGHT`(px)へそれぞれ直接対応するため、moveの`resolveMovePositions`のような座標変換ロジックは不要です(パーセンテージ値をそのまま`percent/100`の倍率として使用)
