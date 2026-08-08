---
title: 'MySQLの日次バックアップをCloudflare R2に自動保存する仕組みを作った話'
description: 'EC2 cron + mysqldump + R2でDBバックアップを自動化した際の設計判断と、AIレビューとの往復で見えてきた運用エッジケースについて'
pubDate: 'Aug 8 2026'
---

## はじめに

個人開発している練習記録サービス[Gyraph](gyraph.com)で、本番MySQLのバックアップが初回リリース以降全く取れていない状態でした。

いつか対応しないといけないと分かっていつつも後回しになっていたのですが、今回ようやく重い腰を上げて「EC2上のcronからmysqldumpを取り、Cloudflare R2に保存する」仕組みを作ったので、その過程を記事にして記録しておきます。

単に動くようになっただけでなく、AIレビューとのやり取りの中で当初は想定していなかった運用上のエッジケースがいくつか洗い出された過程もあったのでそこも含めて書きます。

## 方式を決めるまで

最初に書いたissueでは、実は今回採用した方式とは違う設計を考えていました。

```yaml
database_backup:
  class: DatabaseBackupJob
  schedule: "0 18 * * *"  # UTC 18:00 = JST 03:00
```

Solid Queueの定期実行機能(`recurring.yml`)でジョブを起動し、Rubyの `Aws::S3::Client` でR2にアップロードする案です。アプリケーションのジョブ機構に乗るので実装としては素直に見えました。
※クライアント名と実態が異なるのは既知で、修正予定です。

ただ、インフラ全体を見直していた別issueでの検討の中で、この案には引っかかる点がありました。

- worker コンテナから直接DBコンテナのMySQLに繋いで `mysqldump` を叩く構成だが、workerコンテナに `mysqldump` コマンドを追加でインストールする必要がある
- バックアップ処理自体がアプリケーションのジョブキューに依存する形になり、DBやアプリ側で障害が起きたときに「バックアップを取る仕組み」まで一緒に巻き込まれるリスクがある

バックアップは「アプリケーションが壊れているときにこそ必要になる」ものです。それがアプリケーションのジョブキューに依存しているのは筋が良くないなと思い直しました。

最終的に、EC2ホスト側のcronから直接 `docker compose exec` でmysqldumpを叩き、シェルスクリプトでR2にアップロードする方式に変更しました。既にEC2にはDockerメンテナンス用のcronスクリプト(`docker-cleanup.sh`など)があったので、その資産に乗せる形です。アプリケーションのプロセスとは独立して動く分、DB以外の要因でバックアップが止まりにくくなります。

## 実装の工夫

### ロックなしでバックアップを取る

サービスを止めずにバックアップを取りたかったので、`mysqldump` に `--single-transaction` を付けました。

```bash
mysqldump --single-transaction --quick --routines --triggers --events \
  -u root "$DB_NAME" < /dev/null | gzip > "$DUMP_FILE"
```

InnoDBのテーブルであれば、トランザクション開始時点のスナップショットを見ながらダンプを取るため、テーブルロックをかけずに一貫性のあるバックアップが取得できます。サービスを止めることなく毎日バックアップを回せるのは、この一言のおかげです。

### 世代管理と削除ロジック

`daily/` に7世代、`weekly/`(JST日曜取得分)に4世代を保持し、超過分は自動削除する設計にしました。

```bash
prune() {
  local prefix=$1
  local keep=$2
  local listed keys deletable
  if ! listed=$(r2 s3api list-objects-v2 --bucket "$BACKUP_BUCKET" --prefix "${prefix}/" \
    --query 'sort_by(Contents, &Key)[].Key' --output text 2>&1); then
    log "WARNING: 世代一覧の取得に失敗したため削除をスキップします (${prefix}/): ${listed}"
    return 0
  fi
  keys=$(echo "$listed" | tr '\t' '\n' | grep -v '^None$' || true)
  [ -n "$keys" ] || return 0
  deletable=$(echo "$keys" | head -n -"$keep")
  [ -n "$deletable" ] || return 0
  while IFS= read -r key; do
    if r2 s3 rm "s3://${BACKUP_BUCKET}/${key}" --only-show-errors; then
      log "古いバックアップを削除: ${key}"
    else
      log "WARNING: 古いバックアップの削除に失敗しました: ${key}"
    fi
  done <<< "$deletable"
}
```

オブジェクト名をキー名昇順(=時系列順)に並べ、保持数を超えた古いものから消していくだけの単純なロジックです。ただこの単純な部分も、後述のレビューで何度か手が入りました。

### EXIT trapへの集約

失敗検知の仕組みは、最初は個別にガードを書いていました。「`.env` が読めなかったら失敗ログを出す」「環境変数が足りなかったら失敗ログを出す」というように、失敗しうる箇所ごとに `fail` 関数を挟んでいく形です。

ところがレビューの中で、「`source .env` 自体が構文エラーで失敗したときにログが残らない」という指摘を受けました。個別ガードの積み重ねでは、ガードを書き忘れた経路が必ず抜け穴になります。

そこで、個別ガードを増やすのではなく、**非ゼロ終了時に必ずマーカーを記録するEXIT trapに集約する**構造に変えました。

```bash
DUMP_FILE=""
on_exit() {
  local rc=$?
  [ -n "$DUMP_FILE" ] && rm -f "$DUMP_FILE"
  [ "$rc" -ne 0 ] && log "BACKUP FAILED (exit=$rc)"
  return 0
}
trap on_exit EXIT
```

これを `set -euo pipefail` の直後、スクリプトのごく早い段階で設定しておくと、`source` の構文エラーであっても、ロックファイルの取得失敗であっても、`set -e` によるあらゆる即終了経路を1箇所でカバーできます。一時ファイルの掃除もここに統合しました。

「失敗しうる箇所を全部列挙してガードする」から「失敗したら必ずここを通る場所を1つ作る」への発想の転換で、以降似たような漏れの指摘は出なくなりました。

### setup-cron.shに潜んでいたバグ

今回のスクリプト本体とは別に、既存の `setup-cron.sh`(デプロイのたびにcronエントリを再登録するスクリプト)にバグが見つかりました。

デプロイのたびに以下のような処理でcrontabを書き換えていたのですが、

```bash
sed -i '/docker-cleanup.sh/d' /tmp/mycron
sed -i '/check-disk.sh/d' /tmp/mycron
```

これはコマンド行しか削除しておらず、コメント行(`# Docker cleanup - ...` など)は消していませんでした。結果として、デプロイのたびにコメント行だけがcrontabに積み上がっていくバグが本番に潜んでいて、実際に確認したところ30回以上重複していました。

これを、管理対象をまとめて囲むマーカーブロック方式に変更しました。

```bash
MARKER_BEGIN="# ===== GYRAPH MAINTENANCE BEGIN (setup-cron.sh が自動管理・手動編集しない) ====="
MARKER_END="# ===== GYRAPH MAINTENANCE END ====="

sed -i \
  -e "/^# ===== GYRAPH MAINTENANCE BEGIN/,/^# ===== GYRAPH MAINTENANCE END/d" \
  -e '/docker-cleanup\.sh/d' \
  -e '/check-disk\.sh/d' \
  -e '/db-backup\.sh/d' \
  -e '/^# Docker cleanup/d' \
  -e '/^# Disk check/d' \
  -e '/^# MySQL backup/d' \
  /tmp/mycron
```

毎回ブロックごと消して丸ごと再生成する形にすることで、今後同種のエントリが増えても蓄積しなくなります。手動で登録していた証明書更新用のエントリなど、ブロック外の行には触れない設計にしているので、既存の運用を壊すこともありません。今回のPRの主目的はDBバックアップでしたが、その途中で見つけた別のバグを一緒に潰せたのは収穫でした。

## AIレビューとの往復

このPRは Claude Code Review と Codex という2つのレビューエージェントからレビューを受けました。シェルスクリプトとドキュメントだけの変更ではあるものの、最終的に指摘は合わせて10件を超え、何度もコミットを重ねることになりました。

### 段階的に強化されていった指摘

指摘の一部を紹介すると、こういう流れでした。

- cronのPATHに `/usr/local/bin` が含まれず `docker-compose` が見つからない(Codex, P1)
- リストア失敗時にアプリを再開できてしまう(Codex, P1)
- `prune()` の一覧取得失敗が握りつぶされて世代削除が静かにスキップされ続ける(Claude Code Review, 中)
- 同時実行に対するロックがない(Claude Code Review, 軽微 → その後 `flock -n` で対応)

こういった指摘に一つずつ対応していく中で、当初はシンプルだったスクリプトが少しずつ堅牢になっていきました。

面白かったのは、対応の粒度です。例えば「変数不足時に失敗マーカーが残らない」という指摘に対しては、単に個別のガードを足すのではなく、前述のEXIT trapへの集約という構造変更で応えました。指摘を1つずつ潰すのではなく、複数の指摘に共通する根本原因まで遡って直す、というやり取りが何度かありました。

### レビュー側の指摘をレビュー側が自ら訂正した回

一番印象に残っているのは、Claude Code Reviewが一度「重大」として指摘した内容を、後のコミットで自ら訂正した回です。

リストア手順で「復元前に一度DBをDROP DATABASEしてクリーンな状態から復元する」という変更を入れたところ、次のような指摘が来ました。

> `DROP DATABASE` 後、`db:migrate` だけでは Solid Queue/Cache/Cable のテーブルが復元されず、`data_updates:enqueue` がテーブル不在エラーで失敗する

一見もっともらしい指摘です。Solid Queue関連のテーブルはRailsの通常のmigration管理外(schemaファイル管理)なので、「`db:migrate` では作られない」という事実自体は正しいものでした。

ただ、これは見落としがありました。`mysqldump` はテーブルを個別指定せず物理DB全体をダンプしていたので、Solid Queue関連のテーブルも同じDBに同居している以上、**リストア時のimportの時点で一緒に復元されている**のです。`db:migrate` を待つ必要はありませんでした。

ここで指摘を鵜呑みにせず、実際のダンプファイルの中身を検証しました。

```bash
$ gunzip -c dump.sql.gz | grep -oE 'CREATE TABLE `solid_[a-z_]+`' | sort
CREATE TABLE `solid_queue_blocked_executions`
CREATE TABLE `solid_queue_claimed_executions`
...(solid_queue_* 全11テーブル)
```

このgrep結果を提示したところ、次のレビューで指摘した側が自ら誤りを認めて訂正しました。

> 前回、「重大」指摘をしましたが、これは誤りでした。(中略)前回の指摘は解消済み(というより最初から実害のない誤指摘でした)。お詫びして訂正します。

AIレビューの指摘は的確なことが多い一方で、こういう見落としも普通に起こります。「指摘されたから直す」で思考停止せず、実データで裏を取る一手間の大切さを実感した場面でした。

### 想定していなかった運用エッジケースが次々出てきた

リストア手順は、最初は「DBを止めてダンプを流し込み、アプリを再開する」くらいのシンプルなものを想定していました。ところがレビューを重ねる中で、次のようなエッジケースが次々に洗い出されていきました。

- **一括migrateの危険性**: このプロジェクトには「NOT NULL化やカラム削除などの破壊的なmigration(contract)は、データ移行(expand)と別デプロイに分ける」という規約があります。古い世代のバックアップを復元してから最新コードまで一括でmigrateすると、データ移行より先にcontractが走ってしまい、移行元のデータが失われる可能性がある、という指摘でした。実際に該当する組み合わせがリポジトリ内に存在することも確認され、`VERSION=` を指定した段階的なmigrate手順を追加しました。
- **ジョブの二重実行**: バックアップ取得時点で「未完了」だったジョブも当然リストアで復元されます。その多くは取得後に実際は完了済み(メール送信など)なので、worker起動と同時に二重実行されてしまいます。復元直後にジョブキューを棚卸しして破棄する手順を追加しました。
- **削除済みメディアの欠損**: バックアップ取得後に削除されたアバター画像などは、DBのレコードだけがリストアで復活しても、R2上の実ファイルは既にpurge済みで戻ってきません。「レコードはあるがファイルがない」壊れた参照が残ってしまう問題です。これは是正が難しく、恒久対応の検討は別issueに切り出しました。

どれも、最初にリストア手順を書いていた時点では思い至らなかったものです。バックアップは「取れているか」だけでなく「正しく戻せるか」まで含めて初めて機能する、というのを地で行く経験でした。

## 本番での作業

実装が固まったあと、本番環境で以下の作業を行いました。

1. Cloudflare ダッシュボードでR2バケット `gyraph-backup` を作成
2. 既存のR2 APIトークンのスコープに `gyraph-backup` を追加(それまでメディア用バケットのみにスコープされていたため)
3. EC2上で `db-backup.sh` を手動実行し、初回バックアップを確認
4. リストア演習の実施

リストア演習では、別DB(`gyraph_restore_test`)への復元を行い、本番とテーブル数(40/40)・ユーザー行数(8/8)が完全一致することを確認しました。演習用のDBはもちろん確認後にDROPしています。

```bash
# 検証: テーブル数と主要テーブルの行数を本番と比較
docker-compose -f docker-compose.prod.yml exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" db \
  mysql -u root -e "
    SELECT table_schema, COUNT(*) AS tables FROM information_schema.tables
      WHERE table_schema IN ('gyraph_production','gyraph_restore_test') GROUP BY table_schema;
    SELECT (SELECT COUNT(*) FROM gyraph_production.users)      AS prod_users,
           (SELECT COUNT(*) FROM gyraph_restore_test.users)    AS restored_users;
  "
```

「バックアップスクリプトを書いて満足」で終わらせず、実際に復元できることを確認するところまでやって、ようやく一段落と言える作業だと思います。

## まとめ

今回、MySQLの日次バックアップをCloudflare R2に自動保存する仕組みを、EC2 cron + mysqldump + R2という構成で実装しました。

- アプリケーションのジョブキューに依存させず、ホスト側のcronから独立して動かす方式を選んだ
- `--single-transaction` でロックなしバックアップを実現し、世代管理・EXIT trapによる失敗検知の保証などで堅牢性を積み上げた
- 副産物として、既存スクリプトに潜んでいたcronコメント蓄積バグも修正できた
- AIレビューとの往復では、指摘を鵜呑みにせず実データで検証する重要性と、当初想定していなかった運用エッジケース(一括migrateの危険性・ジョブの二重実行・削除済みメディアの欠損)を洗い出せた

バックアップという地味な作業ですが、「取れているか」だけでなく「戻せるか」まで検証して初めて安心できるものだと改めて感じました。まだ通知経路の整備やメディアバケットの保持設定など残っているタスクもあるので、引き続き手を入れていきたいと思います。
