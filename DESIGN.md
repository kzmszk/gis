# gis — 設計ドキュメント

**gis** (Ghost In the Shell) は、Gas Town を大幅に単純化したエージェントオーケストレーション環境である。
beads で管理されたチケットを、git worktree で分離された複数の AI コーディングエージェントに決定的に配り、
検証を通ったものだけを直列にマージする。

このドキュメントは設計の合意内容であり、実装前の状態を記録したものである。

---

## 1. 核

以下の3つだけを担う。

1. **ワークツリー分離した並列ワーカー**
2. **beads からの決定的な work dispatch**
3. **マージ順序の直列化**

### Gas Town から意図的に捨てたもの

| 捨てたもの | 理由 |
|---|---|
| 常駐監視エージェント (Deacon / Witness / Boot) | 「エージェントの不調をエージェントで直す」は最もデバッグ不能。プロセス生死は herdr のポーリングで足りる |
| Mayor によるクロスリグ調整 | 単一リポジトリなら不要 |
| mail / nudge / broadcast のエージェント間通信 | 直列パイプラインで代替できる |
| convoy / mol / formula のワークフローDSL | beads の依存グラフで足りる |
| Wasteland federation | 単一リポジトリなら不要 |
| 複数リポジトリ横断 | 複雑さの大半の源。別ディレクトリで再起動すれば 90% 足りる |
| 常駐デーモン | 「デーモンが死んだ」「二重起動」「ログはどこ」という運用問題を生む |
| 独自語彙 (rig / polecat / refinery / wasteland) | Gas Town が理解しにくい実体の半分。一般名詞のままにする |

**語彙は一般名詞のみを使う**: worktree / worker / reviewer / merge queue / gate。

---

## 2. 実行モデル

### herdr が実行基盤

ワーカーは herdr のペインの中で**対話モードのまま**動く。gis は herdr の socket API 経由で操作する。

```
herdr worktree create --branch <bead-id> --base main
herdr agent start <name> --kind <claude|codex|pi> --pane <id>
herdr agent prompt <name> "Read .gis/prompt.md and execute it."
herdr agent wait <name> --until done --until blocked
herdr agent read <name> --lines N
herdr api snapshot
herdr worktree remove
```

herdr は claude / codex / pi を一級市民として認識し、`working / blocked / done` の状態検知を提供する。
この状態検知を gis が自前で実装する必要はない。

### 帰結: stdout は読めない

エージェントは PTY の中で動くため、**gis はワーカーの標準出力を読めない**。
`herdr agent read` が返すのは端末スナップショット (`visible` / `recent`) であり、完全なトランスクリプトではない。

したがって **エージェント → gis の情報チャネルはファイルシステムのみ**である。

これは制約であると同時に利点でもある。

- 「画面を読んで判断する」という最も壊れやすい経路が構造的に禁止される
- `claude -p` の JSONL パースも `--resume <session-id>` の管理も不要
- ハーネス3種 (claude / codex / pi) が同一インターフェースで扱える

### オーケストレータ

- **常駐デーモンにしない。** `gis run` をフォアグラウンドループとして herdr のペインの1つで動かす
- gis 自身も herdr が管理するプロセスの一つになり、人間から見えて Ctrl-C で止められる
- 実装言語は **TypeScript**（やることが実質「`bd` と `herdr` と `git` を叩いて JSON を読む」だけ）

---

## 3. 状態の在り処

**真実の源は2つだけ。**

| 何が | どこに |
|---|---|
| 何をすべきか（issue・依存・優先度） | **beads** |
| 今何が動いているか（ペイン・worktree） | **herdr の live snapshot** |
| 揮発的状態（pid、pane ID） | **どこにも永続しない** |

揮発的状態を永続ストアに置くと、必ず整合性回復コードが生える
（Gas Town の `gt orphans` / `gt release` / `gt cleanup` はこれが理由）。

### bd への書き込みは gis が独占する

エージェントには `bd` を触らせない。触らせるとディスパッチの決定性が崩れ、
エージェントが自分の状態やゲートを書き換えられるようになる。

ステータス遷移は beads 標準の3つのみ。`reviewing` や `merging` のような細かいステータスは持たない
（フェーズは揮発的状態であり、herdr のペインを見れば分かる）。

```
ディスパッチ  →  in_progress  (assignee = kind)
マージ成功    →  closed
エスカレーション →  blocked
```

`blocked` に落ちるときは notes に**3点セット**を書く。人間が引き継ぐための唯一の接点。

1. worktree のパス
2. ラウンドログの場所
3. トランスクリプトのパス

---

## 4. bead 1件のライフサイクル

```
bd ready --exclude-label human
  └ 優先度順に空きスロットへ（決定的、LLM 不使用）
      └ bead の type / profile: ラベルからプロファイルを解決（第5章）
      └ herdr worktree create --branch <bead-id> --base main
      └ .gis/run/prompt.md を書く
      └ herdr agent start --kind <実装kind>
      └ herdr agent prompt "Read .gis/run/prompt.md and execute it."
      └ herdr agent wait --until done --until blocked

  [フェーズ1] verify ループ（上限 verify_max）
      verify コマンドを実行
        失敗 → 同じ実装ペインに指摘を投げ直す（文脈は保持されたまま）

  [フェーズ2] review ループ（上限 review_max、段階2で有効化）
      実装と必ず違う kind のレビュアーを起動（bead 完了まで生存）
      「修正 → verify → 再レビュー」の一巡で review カウンタを1消費
      ※ この中の verify 失敗は verify カウンタを消費しない

  [マージ] 直列キューに投入
      1本ずつ main に rebase → base より先の commit があることを確認
      → verify を再実行 → 通れば merge

  成功         → bd close → worktree と pane を破棄 → 統合済み bead branch を削除
  上限超過/blocked → bd を blocked にし、worktree と pane は保持したまま人間へ通知
```

### ペインの寿命

**bead 単位で使い捨て。** 新しい bead では必ずまっさらなペインを立てる。
1つの bead の中の N ラウンドだけ、実装ペインとレビュアーペインが文脈を共有する。

これは herdr を使うことで安価に実現できる。ペインが生きたままなので
`herdr agent prompt` を投げ直すだけでよく、セッション再開フラグもコンテキスト復元も要らない。

### レビュアーも bead 完了まで生存する

同一レビュアーが N ラウンド見るので「前回自分が指摘したことが直ったか」を差分で判定できる。
ラウンドごとに新しいレビュアーを立てると毎回違う指摘が出て**収束しない** —
LLM 相互レビューが発散する主因はここにある。

### レビュアーは実装と必ず違う kind

claude が実装したら codex がレビューする。同じモデルにレビューさせると同じ盲点を共有するため、
レビューの価値の大半が失われる。異なるベンダのモデルを当てることに意味がある。

### verify を先に置く

verify は無料（数十秒の CPU）、レビューは有料（サブスク枠）という非対称があるので、安いゲートを先に置く。
テストが落ちているコードをレビュアーに見せてもトークンの浪費にしかならない。

副次的な効果として、verify 失敗とレビュー失敗が
**同じ「実装ペインに指摘を投げ直す」機構の2つの入口**に統一され、実装が1本で済む。

### マージ時に rebase してから verify を再実行する

個別に通ったブランチ同士が合流すると壊れる、というのが並列開発の主要な失敗モードである。
これは**捨ててはいけない複雑さ**（Gas Town の Refinery が存在する理由もここ）。
ワーカーには変更を commit してから完了報告するよう指示し、マージキューでも
`base..HEAD` が空でないことを検証する。変更ゼロのブランチを成功扱いして bead を close しない。

---

## 5. ワーカーの起動設定（モデル・effort・承認）

ワーカーの挙動は、すべて **`herdr agent start` の trailing args としてエージェントに素通しされる起動時フラグ**で決まる。

```
herdr agent start <NAME> --kind <KIND> --pane <ID> [-- [AGENT_ARG]...]
                                                     ↑ ここから先がエージェントに渡る
```

### 5.1 承認・自律性

```
claude --permission-mode auto
codex  -a on-request -s workspace-write
```

- `claude` の `auto` は分類器が各ツール呼び出しの安全性を判定する。
  **分類器はツールの実行結果を見ず、提案されたコールだけを見る**ため、
  読み込んだファイルに仕込まれたテキストで判断を曲げられない（プロンプトインジェクション耐性が設計に入っている）。
  アカウント単位の一度きりのオプトインが必要。
- 使えない環境では設定で `acceptEdits` に落とす。**コードで分岐せず設定値にする。**
- **`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` は使わない。**
  worktree は git の分離であってファイルシステム/ネットワークの分離ではない。
  並列4本が同時に暴走したときに気づく手段が無くなる。

**承認プロンプト = herdr の `blocked` = 人間へのエスカレーション経路** として二重に機能させる。

> 既知のトレードオフ: `auto` にすると `blocked` の発火頻度が下がる。
> 危険な操作では依然エスカレートするので壊れはしないが、
> 「気づける粒度が粗くなる」ことは受け入れた上での選択である。

### 5.2 モデルプロファイル

役割ごとにモデルと effort を事前に決めておく。

| | モデル | effort |
|---|---|---|
| claude | `--model opus` / `--model claude-opus-5` | `--effort <low\|medium\|high\|xhigh\|max>` |
| codex | `-m gpt-5.6-luna` | `-c model_reasoning_effort="xhigh"` |

codex 側は専用フラグではなく config 上書きだが、`~/.codex/config.toml` の
`model` / `model_reasoning_effort` と同じキーなので確実である。

**プロファイルは順序付きの候補リスト**とする。gis は先頭から順に、
空きスロットのある最初の候補を選ぶ。

```
plan       claude/opus/medium  →  codex/gpt-5.6-sol/high
implement  codex/gpt-5.6-luna/xhigh  →  claude/opus/xhigh
review     claude/opus/xhigh   →  codex/gpt-5.6-sol/xhigh
```

**モデル名は gis 側で検証しない。** `kinds` と同じく素通しの設定値として扱う。
モデルは頻繁に増減するので、バリデーションを持つと gis 自体の更新が必要になる。

### 5.3 プロファイルの選択

| 役割 | 選択方法 |
|---|---|
| `review` | パイプラインの段階なので gis が自明に判定する |
| `plan` | bead の **type が `decision` または `epic`** |
| `implement` | 上記以外（デフォルト） |
| 上書き | bead に `profile:<name>` ラベルがあればそれを優先 |

beads の `decision` 型は「設計判断を記録する issue」として標準で存在するため、
ラベルで別軸を作るより既にある型を使うほうが増える概念が少ない。
取りこぼしは必ずあるので `profile:` ラベルでの明示的上書きを認める。
**これは決定的な判定であり、LLM に振り分けさせるわけではない。**

### 5.4 候補フォールバック

発火条件は **起動失敗のみ**。`herdr agent start` が失敗した場合、
または起動後に結果ファイルを残さず短時間で終了した場合、次の候補に移る。

**端末スナップショットの文字列照合（レート制限メッセージの検出など）は行わない。**
第2章で構造的に禁じた「画面を読んで判断する」経路を復活させることになり、
しかもメッセージの文言は予告なく変わるため、静かに壊れて
「なぜかフォールバックしない」という最も気づきにくい故障になる。

起動できたかどうかという二値なら、レート制限に限らず
あらゆる起動失敗（設定ミス、モデル名の typo、認証切れ）を同じ経路で拾える。

> **できないこと**: 残量を事前に照会する手段は、どちらの CLI にも存在しない
> （`codex doctor --json` は auth とランタイム健全性のみ、claude の `/usage` は TUI 専用、
> `claude --fallback-model` は `--print` 専用で対話モードでは使えない）。
> したがって「codex の残りが少ないから claude にする」という**予測的な振り分けは実装できない**。
> 走行中の枯渇は結果ファイル欠損として現れ、最終的に `blocked` に落ちる。
> 対処は第6章の通り、人間が `concurrency` を下げるか候補順を入れ替えて `gis run` を叩き直すこと。
> 実行が一回で完結する（第10章）ため、実行と実行の間が自然な調整点になっている。

### 5.5 レビュアーの kind 決定順序

レビュアーは実装と必ず違う kind を使う（第4章）。
候補フォールバックがあるため、**実装がどちらの候補で走ったかが確定してから**
`review` プロファイルの候補リストを走査し、実装で使った kind を除外して最初の候補を選ぶ。

---

## 6. 並列度

**bead 単位で数える**（`concurrency` の数字1つ）。

実装ペインとレビュアーペインは交互に動き、**同時にトークンを消費しない**。
ペイン単位で数えると実際の消費量の倍を確保してしまい、並列度が不必要に半減する。

Claude と ChatGPT のサブスク枠は別建てなので実質的に分離される。
レートリミットの自動縮退もアカウントローテーションも実装しない（複雑さの温床であり、並列度を手で下げれば回避できる）。

---

## 7. エスカレーションとログ

### blocked の扱い

- herdr で通知し、**ペインはそのまま残す**。人間がアタッチして手で解く
- **定型返答の自動投入は絶対にしない。** 承認プロンプトに自動で yes を返す仕組みは、事故が起きたときに誰も止められない
- `blocked_timeout` 経過後も blocked なら撤退し、bead を `blocked` にする
- done / blocked のどちらも返さないワーカーは `worker_timeout` で打ち切り、worktree を保持して blocked にする
- verify コマンドは `verify_timeout` で打ち切る。ハングした検証を無期限に待たない

### worktree は成功時にしか破棄しない

破棄するのは「マージ成功時」と「人間が明示的に捨てた時」だけ。
失敗した worktree を消すと調査ができなくなる。人間が `herdr worktree open` で入って続きをやれる状態にしておく。

### ログは自前で作らない

claude / codex は既に cwd ごとに完全な JSONL トランスクリプトを永続している。

- `~/.claude/projects/<cwd-slug>/*.jsonl`
- `~/.codex/sessions/<year>/...`

worktree ごとに cwd が違うので自動的に分離される。
**gis が残すのは「どの bead が、どの worktree で、どのトランスクリプトに対応するか」という索引だけ。**

### ラウンドの応酬は worktree 内に番号付きで残す

```
.gis/run/round-1-impl.json
.gis/run/round-1-review.json
.gis/run/round-2-impl.json
...
```

トランスクリプトは長すぎて人間が読めない。人間にエスカレートしたとき、
**worktree に入るだけで全ラウンドの応酬が読める**ことが実質の引き継ぎ資料になる。

### エージェント → gis の返答プロトコル

エージェントは終了時に結果ファイルを書く。`status` / `summary`、レビュアーなら `verdict`、
人間の確認が必要と判断した場合は `needs_human: "<理由>"`。

**解釈と永続化は gis が行う。** ファイルが無ければ「異常終了」として扱える。

---

## 8. クラッシュ復旧

`gis run` はフォアグラウンドループなので、Ctrl-C や異常終了がありうる。
再起動時に**3者照合を1回だけ**行う。

```
herdr api snapshot  ×  git worktree list  ×  bd list --status=in_progress
```

| 状態 | 対応 |
|---|---|
| in_progress だがペインも worktree も無い | bead を open に戻す |
| in_progress で worktree は残るがペインが無い | 実在する worktree パスを記録して bead を blocked にする |
| ペインはあるが対応する bead が無い | 人間に報告して放置 |

揮発的状態を永続していないため、単純な集合演算で済む。

---

## 9. 人間による確認ゲート

### 仕組み

beads の依存グラフをそのまま使う。gis 側の実装は
「`bd ready --exclude-label human` を引く」の1箇所だけ。

```
[source A/B/C] ──(blocked handoff, edge is replaced)──┐
                                                      ├──> [後続 bead D, E]
[ゲート bead (label: human)] ──────────────────────────┘
          ↑ gis は絶対に触らない                       ↑ bd ready に現れない
```

ここで `needs_human` を返した source は handoff のため `blocked` になる。
したがって gis は gate を source の依存先にはしない（blocked source に
gate を依存させると通常の `bd human respond` が gate を close できず、
グラフがデッドロックする）。source を直接 blocker とする既存の後続 bead
があれば、gis は `gate -> 後続` の edge を先に追加してから
`source -> 後続` の edge を外す。source 自体は blocked のまま worktree と
handoff を保持し、human が gate に応答して close した時点で後続だけが
`bd ready` に現れる。source を参照する edge が無い場合も、gate は独立した
human checkpoint として作成され、後から gate を依存先にした後続を止める。

1. `--exclude-label human` により、ゲート bead は**ディスパッチ対象から構造的に除外される**
2. 後続は依存でブロックされ、`bd ready` に現れない。gis は存在すら知らない
3. 人間が `bd human list` → 確認 → `bd human respond <id>`（コメントを付けて close）
4. 次の `gis run` で後続が `bd ready` に現れ、処理が再開する

**「勝手に進めない」がエージェントの自制ではなく、依存グラフの形で保証される。**
LLM に「ここで止まれ」と指示する方式なら守られない可能性があるが、これは構造的に不可能である。

### 誰が作るか

- **基本は人間。** エピックを切るときに `bd create --labels human` でチェックポイントを置き、
  `bd dep add` で後続を吊る
- **エージェントからの要求は間接経路のみ。** ワーカーは結果ファイルに `needs_human: "<理由>"` を書くだけで、
  ゲート bead を**作るのは gis**。エージェントに `bd create` を叩かせると、
  自分でゲートを作ったり回避したりできてしまう

### マージゲートは作らない

「実装はさせるがマージ前に承認を待つ」という別種のゲートは導入しない。
承認待ちのブランチが直列マージキューを塞ぐか、追い越しを許して順序保証を壊すかの二択になり、
「rebase してから再 verify」の直列性が濁る。

前進ゲートは**キューの外側**にあるのでこの副作用が無く、同じ目的を達成できる
（マージ後の確認をしたければ、ゲート bead の内容を「直前のマージ結果をレビューする」にすればよい）。

### molecule ゲートは使わない

beads には `--waits-for-gate` / `bd ready --gated` という molecule 用のゲート機構もあるが、
mol / formula を捨てたので素の依存関係で足りる。

---

## 10. 終了条件

`bd ready` が空（かつ実行中の bead も無い）になったら、**`gis run` は終了する**。

ポーリングして待ち続けると「止まっているのか待っているのか分からない」状態を作り、
実質デーモンになって捨てたはずの運用問題が戻ってくる。

終了時にサマリを出す。

```
N 件マージ / M 件 blocked / K 件が人間の確認待ち
```

`K` は今回作成したものに限らず、リポジトリ内に残っている open な human bead の総数。

一回の実行が一つの完結した単位になり、**なぜ止まったかが必ず提示される**。
ready があるうちは走り続けるので、依存グラフは自動的に前進する
（`bd close` した瞬間に依存先のブロックが外れ、次のループで拾われる）。

もう一度回したければ `gis run` を叩き直すだけ。

---

## 11. 設定

`.gis/config.toml`（リポジトリにコミットする）:

```toml
concurrency = 3
base = "main"
verify = "npm test && npm run lint"
kinds = ["claude", "codex"]      # pi は値を足すだけで有効になる
review = false                   # 段階2で true
verify_max = 5
review_max = 3
blocked_timeout = "15m"
worker_timeout = "1h"
verify_timeout = "15m"
claude_permission_mode = "auto"  # 使えなければ "acceptEdits"

# --- モデルプロファイル（第5章）: 順序付き候補リスト、先頭優先 ---

[[profiles.plan]]                # bead type が decision / epic
kind = "claude"; model = "opus";          effort = "medium"
[[profiles.plan]]
kind = "codex";  model = "gpt-5.6-sol";   effort = "high"

[[profiles.implement]]           # 上記以外（デフォルト）
kind = "codex";  model = "gpt-5.6-luna";  effort = "xhigh"
[[profiles.implement]]
kind = "claude"; model = "opus";          effort = "xhigh"

[[profiles.review]]              # 段階2。実装で使った kind は除外される
kind = "claude"; model = "opus";          effort = "xhigh"
[[profiles.review]]
kind = "codex";  model = "gpt-5.6-sol";   effort = "xhigh"
```

bead 側での上書き:

```bash
bd create --labels profile:plan ...   # 型に関わらず plan プロファイルを使う
```

### ディレクトリ規約

| パス | 内容 | git |
|---|---|---|
| `.gis/config.toml` | 設定 | コミットする |
| `.gis/run/` | worktree 内の一時成果物（prompt.md、ラウンドログ） | gitignore する |

---

## 12. 着手順

### 段階1 — レビューなし

```
dispatch → worktree → 実装ペイン → verify ループ → 直列マージキュー → 復旧照合
```

**これだけで核の3つ（並列ワーカー / beads dispatch / マージ直列化）は完全に満たされる。**

### 段階2 — 相互レビュー

異ベンダのレビュアー、N ラウンド収束、レビュアーの生存管理。

段階1を実際に使ってレビューが本当に必要かを実測してから入る。
土台が動いていない状態でプロンプトや収束条件を調整すると、問題の切り分けができない。

---

## 13. 残るリスク

設計では解けないもの。

### Anthropic のサードパーティ課金ポリシー

2026年に4回変わっている。

| 時期 | 内容 |
|---|---|
| 2026/1 | サブスク OAuth をサードパーティでブロック → 数日で撤回 |
| 2026/2 | ToS で OAuth を Claude Code / claude.ai に限定 |
| 2026/4/4 | サブスクはサードパーティをカバーしないと発表・実施 |
| 2026/5/14 | 別建ての Agent SDK クレジットプールを発表（Pro $20 / Max5x $100 / Max20x $200、月次失効） |
| 2026/6/15 | **その変更を pause。現行は「third-party app usage still draw from your subscription's usage limits」** |

Anthropic は「作り直して事前告知の上で再導入する」と明言している。

**claude / codex を直接使う段階1はこの影響を受けない。** `kinds` に残した `pi` 経路だけがこのリスクを負う。
pi を「設定値の1つ」に留めた判断が、このリスクを封じ込めている。

また、Anthropic が挙げた技術的理由は「サードパーティは prompt cache を回避するので同じ仕事でコストが数倍」であり、
許可されていても pi は claude CLI より速くサブスク枠を消費する。

### auto はエスカレーション頻度を意図的に下げる

第5章に記載のトレードオフ。

### 異ベンダ相互レビューの実効性は未検証

段階1で実測してから段階2に進む、という着手順自体がこのリスクへの対処になっている。

---

## 付録: 設計判断の記録

| # | 決定 | 理由の要点 |
|---|---|---|
| 1 | 核は3つのみ | 監視エージェント群が Gas Town の複雑さの過半 |
| 2 | herdr が実行基盤 | 状態検知 (`working/blocked/done`) が既に実装されている |
| 3 | ワーカーは claude + codex（pi は設定値） | サブスク枠で動き、herdr が抽象化するので pi を挟む理由がない |
| 4 | beads は永続すべきものだけ | 揮発状態の永続が整合性回復コードを生む |
| 5 | ディスパッチは決定的コード | 順序の知能は beads の依存グラフが既に持っている |
| 6 | 単一リポジトリ | 複雑さの大半はクロスリポジトリ調整から来る |
| 7 | 並列度は bead 単位で固定 | 実装とレビューは同時にトークンを消費しない |
| 8 | 1 bead = 1 worktree、bead 単位で使い捨て | 失敗時の回復が「消してやり直す」だけになる |
| 9 | 合否は決定的な verify コマンド | 「エージェントが done と言った」と「仕事が終わった」は別物 |
| 10 | blocked は通知して待つ、自動応答しない | 承認に自動 yes を返す仕組みは事故を止められない |
| 11 | 直列マージキュー、rebase 後に再 verify | 個別に通ったブランチの合流が主要な失敗モード |
| 12 | 割当は無差別、レビュアーは異 kind | どちらが何に強いかの決め打ちは陳腐化する／同一モデルは盲点を共有する |
| 13 | フォアグラウンドループ、TypeScript | デーモン化が運用問題を生む |
| 14 | 承認は auto / on-request、dangerous 系は使わない | 承認プロンプトをエスカレーション経路として再利用する |
| 15 | プロンプトはファイル経由、送るのは1行 | TUI へのテキスト注入でエスケープが壊れる |
| 16 | 返答は結果ファイル、bd 書き込みは gis 独占 | 責任の分離とディスパッチの決定性 |
| 17 | 同一ペインで N ラウンド、同一レビュアー | 文脈を作り直さない／指摘が発散しない |
| 18 | verify / review はカウンタを分ける | コンパイルエラーには回数が要る（機械判定なので発散しない） |
| 19 | フェーズで所有権を切る | 「verify_max はレビュー前ループ、review_max はレビュー後ループ」で言い切れる |
| 20 | ログは公式トランスクリプトに委ね索引のみ残す | 自前のログ基盤は純粋な重複 |
| 21 | 起動時に3者照合 | 揮発状態を永続していないので集合演算で済む |
| 22 | ready が空なら終了する | 待ち続けると実質デーモンになる |
| 23 | ゲートは human ラベル + 依存関係 | 「進まない」がグラフの形で保証される |
| 24 | マージゲートは作らない | 直列キューの順序保証が濁る |
| 25 | 段階1はレビューなしで動かす | 土台が動く前にレビューを調整すると切り分けできない |
| 26 | 役割ごとのモデル/effort をプロファイルとして設定に持つ | 決め打ちのコストがコードでなく設定に乗るなら、判断を固定する方が結果が良い |
| 27 | プロファイルは順序付き候補リスト | 「A or B」という要件をそのまま表現でき、フォールバックと同じ機構で済む |
| 28 | プロファイル選択は bead の type + `profile:` ラベル上書き | `decision` 型は beads 標準で意味が一致する／増える概念が少ない |
| 29 | フォールバックは起動失敗のみで発火 | 画面の文字列照合は禁じた経路の復活であり、文言変更で静かに壊れる |
| 30 | モデル名を検証しない | モデルは頻繁に増減する。素通しなら gis の更新が要らない |
