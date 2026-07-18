---
title: 'Railsアプリケーションの呼び出しツリーを出すgem「call_map」を作ってみた'
description: 'Railsアプリケーションの処理の流れを俯瞰するために、Prismで静的解析して呼び出しツリーを出すgemを作った話'
pubDate: 'Jul 18 2026'
---

## はじめに

先日北海道の函館で開催されたRubyKaigiに初めて参加してきました。

いろいろなRubyistの方と交流できてめちゃ楽しかったです。

その余韻もあり、「Kaigi Effectで何か作りたい」と思って作ったのが `call_map` というgemです。

`call_map` は、Railsアプリケーションの任意のメソッドを起点に、そこから呼び出されるメソッドをツリー形式で出力するgemです。

今回の記事ではその `call_map`について紹介します。

※このブログ記事は2026年7月13日に株式会社ANDPADで開催されたKaigiEffect Kaigi 2026というRubyKaigiのアフターイベントで発表した内容をブログにした記事になります。

https://speakerdeck.com/bumpfuji10/prismderailsapurikesiyonnohu-bichu-situriwochu-sugem-call-map-wozuo-tutemita

## なぜ作ったか

自分がエンジニア初心者のときや、初めて参加する現場では、コードベースの流れをざっくり掴むために長めのコードリーディングをすることがあります。

そのたびに、処理の流れやコードベースを俯瞰で見たいと思っていました。

例えば、Railsのコントローラアクションからサービスクラスに潜り、さらに別ファイルのconcernに移動して、そこからまた別のメソッドを探しにいくようなケースです。

```ruby
# orders_controller.rb
def destroy
  @order = Order.find(params[:id])
  authorize_order!
  OrderDeleteService.execute(@order)
  redirect_to orders_path
end
```

```ruby
# order_delete_service.rb
def execute
  validate_deletable!
  destroy_order!
  notify_deleted
end
```

```ruby
# concerns/order_deletion.rb
def destroy_order!
  @order.destroy!
  audit_log(:order_destroyed)
end
```

`audit_log` を探しているころには、「あとで読む」と思っていた `authorize_order!` や `validate_deletable!` の存在を忘れるといったケースがよくありました。

ファイルを移動するたびに小さなコンテキストスイッチが起きて、頭の中の浅い「あとで読む」スタックから少しずつこぼれ落ちていくような感覚です。

それなら、起点となるメソッドから呼び出し先をツリーとして出せると便利なのでは、と思いました。

## call_mapでできること

`call_map` でできることは、ざっくり以下です。

- 任意のメソッド起点の呼び出しツリーをテキストで出力する
- コントローラアクション起点なら `before_action` 込みで実行順を再現する
- Railsを起動せず、PrismでRubyコードを静的解析する
- NotionやPRにそのまま貼れる形式で出力する

出力はこんな感じです。

```text
OrdersController#destroy
├─ before_action authenticate_user!
├─ before_action set_order
│  └─ current_user.orders.find [framework]
├─ authorize_order!
│  └─ OrderPolicy#destroy?
├─ OrderDeleteService.execute
│  └─ OrderDeleteService#execute
│     ├─ validate_deletable!
│     │  └─ OrderDeletionPolicy#validate!
│     ├─ destroy_order!
│     │  └─ @order.destroy! [framework]
│     └─ notify_deleted
│        └─ OrderDeletedNotifier.call
└─ redirect_to [framework]
```

## 仕組み

仕組みはざっくり2つです。

1. 索引を作る
2. 起点から掘る

まず `app/**/*.rb` を全部parseして、クラスやメソッドの定義場所を記録します。

そのあと、指定された起点メソッドの本文を読み、呼び出しを索引で解決します。見つかった先もさらに掘っていき、最後にツリーとして出力します。

やっていることは「地図づくり」と「地図を使った探索」です。

コードを読むことやツリーを出すこと自体は、思っていたよりも素直に実装できました。

一方で、工数の多くは「この呼び出しは、どのメソッドのことか」を当てる部分にかかりました。

Rubyがメソッドや定数を探すルールを、静的解析の上でできるだけ再現する必要があったからです。

ここからは開発するうえで感じた「つらみ」の一部を紹介します。

## つらみその1: そのUser.allはどっちのUserか

例えば、Railsアプリケーション内に `User` が2つあるケースを考えます。

```ruby
# app/models/user.rb
class User < ApplicationRecord
end
```

```ruby
# app/models/admin/user.rb
module Admin
  class User < ApplicationRecord
  end
end
```

この状態で、管理画面のコントローラから `User.all` を呼び出したとします。

```ruby
module Admin
  class UsersController
    def index
      @users = User.all
    end
  end
end
```

この場合、Rubyはソースコード上で囲んでいる `Admin` の中を先に探すため、`User` は `Admin::User` に解決されます。

一方で、次のように1行でクラス名を書いた場合は挙動が変わります。

```ruby
class Admin::UsersController
  def index
    @users = User.all
  end
end
```

この場合、コード上に `module Admin` のブロックがありません。そのため、`Admin` の中は探索されず、トップレベルの `User` に解決されます。

同じ `Admin::UsersController` でも、書き方によって定数解決の結果が変わるわけです。

`call_map` では、この「囲まれ方」ごと索引に登録するようにしました。

```ruby
Definition(
  owner: "Admin::UsersController",
  lexical_nesting: ["Admin", "Admin::UsersController"],
)
```

クラス名だけを文字列で持つのではなく、ソースコード上のネスト情報も一緒に保存します。

呼び出しに出会ったら、この記録を内側から外側へ辿って候補を探します。これにより、Rubyの定数解決に近い手順を索引の上で再現しようとしています。

## つらみその2: before_actionの再現

Railsのコントローラを起点にするなら、`before_action` も実行順に含めたいです。

ただ、これは「コントローラに書いてあるcallbackを上から順に出せばよい」という話ではありませんでした。

### 複数書かれている場合がある

`before_action` は1行で複数指定できます。

```ruby
before_action :authenticate_user!, :set_order
```

この場合、1つの宣言をばらして、宣言順に並べる必要があります。

### only / exceptで対象が変わる

`only` や `except` によって、対象となるアクションが変わります。

```ruby
before_action :set_order, only: [:show, :destroy]
before_action :check_plan, except: "index"
```

しかも、シンボルでも文字列でも書けます。

そのため、アクション名を比較するときは、値を揃えてから判定する必要があります。

### 親クラスのcallbackも動く

親クラスに定義されたcallbackも、子クラスのアクション実行時に動きます。

```ruby
class ApplicationController < ActionController::Base
  before_action :authenticate_user!
end

class OrdersController < ApplicationController
  before_action :set_order
end
```

この場合、`OrdersController#destroy` を起点にしたときは、親の `authenticate_user!` が先に動き、そのあと子の `set_order` が動きます。

コントローラを1ファイル読むだけでは、全体の実行順は分かりません。

### skip_before_actionがある

さらに `skip_before_action` もあります。

```ruby
class ApplicationController < ActionController::Base
  before_action :authenticate_user!
end

class LpController < ApplicationController
  skip_before_action :authenticate_user!
end
```

親で定義されたcallbackを、子で外すケースです。

さらに、skipしたあとに再追加されることもあります。

```ruby
class ApplicationController < ActionController::Base
  before_action :authenticate_user!
end

class LpController < ApplicationController
  skip_before_action :authenticate_user!
end

class MemberLpController < LpController
  before_action :authenticate_user!
end
```

この場合、`LpController` では外された `authenticate_user!` が、`MemberLpController` では再び動きます。

単純に「呼ばれているメソッドを上から順に見てリストに足す」だけでは再現できません。

宣言順と継承順を踏まえて、できるだけRailsの実行順に近づける必要があります。

この部分は結局7回くらい作り直しました。

## 動的な呼び出しには対応していない

静的解析なので、`send` や `eval` のような動的な呼び出しには対応していません。

```ruby
user.send(dynamic_method)
eval(code_string)
def method_missing(name, ...)
end
```

これらは、実行してみるまで何を呼ぶか分からないケースがあります。

現状では、次のように扱っています。

- `send` / `public_send` は `[dynamic]` タグ付きの葉として表示する
- 解決できない呼び出しは、それ以上潜らず葉として打ち止める

ここは素直に諦めました。

静的解析で全部を正確に追うのは難しいので、追えるところまで追い、追えないところは追えないものとして表示する方針です。

## 作ってみて感じたこと

作る前は、「Rubyに詳しくないとこういうものは作れない」と思っていました。

しかし実際には、**作りながら徐々にRubyに詳しくなっていく感覚**がありました。

定数解決、継承、Railsのcallback、静的解析の限界など、普段アプリケーションを書いているだけでは曖昧なまま流していた部分に向き合うことになりました。

ライブラリを作るのは、その言語やフレームワークの仕様に少し深く潜るよい機会だなと思いました。

## これから

今後は、以下のようなことをやっていきたいです。

- concernの `include` / `extend` によるメソッド解決
- 葉を `[db-write]` `[enqueue]` `[mail]` のように意味づけするeffect map
- 逆方向トレース
- MCP server化

逆方向トレースは、「このメソッドを変更したら、どのcontroller actionに影響するか」を見られる機能です。

変更影響範囲をざっくり掴む用途として面白そうだと思っています。

## まとめ

`call_map` は、Railsアプリケーションの処理の流れをざっくり俯瞰するために作ったgemです。

Railsを起動せず、Prismで静的解析して、指定したメソッドから呼び出しツリーを出力します。

まだ対応できていないケースはありますが、コードリーディングやPRレビューの補助として使えるものを目指しています。

RubyGemsで公開しています。

```bash
gem install call_map
```

GitHubはこちらです。

https://github.com/bumpfuji10/call_map
