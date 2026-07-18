---
title: 'Astroでブログを作った'
description: 'Astroの基本的な使い方とブログサイトの構築方法を紹介します'
pubDate: 'Jul 18 2026'
---

## はじめに

今までmicroCMS + Next.jsで構築したブログサイトを、Astroで作り直しました。

動機は、
- 運用を軽くしたかった。
  - Next.jsは柔軟な開発ができるが、シンプルなブログサイトに使うには少々オーバースペックだった。
  - microCMSでブログ記事を書くのが面倒になってきた。
- Astroを使ってみたくなった。

です。

## Astroとは
https://docs.astro.build/ja/concepts/why-astro/

Astroは近年技術者の間で人気のウェブフレームワークです。

静的サイトジェネレータとしてサイト内の**コンテンツを素早く配信することに特化**しています。

サーバーファーストの思想を採用していて、SSGを中心としてコンテンツ配信ができます。 ※必要に応じてSSRも可能

その結果、高パフォーマンスのウェブサイト構築が可能になります。

また、ReactやVue.jsなどで書かれたコンポーネントを部分的に差し込むことができるため、用途に応じた柔軟な開発体験を提供してくれています。

## Astroの主な特徴

### 1. アイランドアーキテクチャ
ここでいうアイランドとは、
- webページの静的な部分を「海」
- 動的な部分を「島」

に分割して設計する考え方です。
アイランドアーキテクチャはこの考え方に則って、「画面の大部分を静的なHTMLにレンダリングし、必要な部分だけを独立した単位に分割」する設計思想です。

アイランドアーキテクチャにおける動的な「島」のコンポーネントは、
- クライアントアイランド
- サーバーアイランド
この2つに分かれます。

クライアントアイランドは、「ブラウザでJavaScriptが動くインタラクティブなコンポーネント」です。たとえばボタンのUIや、検索ボックス、ユーザーの操作によって状態が変わるようなUIコンポーネントです。ユーザーの操作によって即時に見た目が変化します。

Astroでは、必要なコンポーネントにだけクライアントサイドJavaScriptを読み込ませることで、ページ全体に不要なJavaScriptを送らずに済みます。これがAstroの高速なパフォーマンスを支える考え方の一つです。

サーバーアイランドは、「サーバーでレンダリングされる動的なコンポーネント」です。時間のかかる処理や、パーソナライズされた表示を、ページ本体のレンダリングから切り離してサーバー側で遅延レンダリングするための仕組みです。

この設計思想によって、ページ全体の表示を遅らせることなく、必要な一部のコンポーネントだけをあとから読み込み表示させることが可能になります。

### 2. 好きなUIフレームワークを使える

AstroはReact、Vue、Svelte、Solid、Preactなど、好みのUIフレームワークを自由に使えます。かつ同じプロジェクト内で複数のフレームワークを混在させることも可能です。

```bash
# Reactを追加
npx astro add react

# Vueを追加
npx astro add vue

# Svelteを追加
npx astro add svelte
```

例えば、既存のReactコンポーネントをそのまま使いつつ、新しい部分はSvelteで書く、といったことができます。個人のスキルセットや既存コードを活かしながら、段階的にAstroへ移行できるのは大きなメリットです。

### 3. Markdownファーストなコンテンツ管理

ブログ記事はMarkdownで書くだけで作成できます。

フロント側でメタデータを定義でき、コンテンツの管理が非常にシンプルでよきです。

```md
---
title: '記事タイトル'
description: '記事の説明文'
pubDate: '2026-07-17'
author: 'kyam'
tags: ['astro', 'web開発']
---

## 見出し

本文をここに書きます。

- リスト項目1
- リスト項目2
- リスト項目3

**太字**や*斜体*も使えます。
```

さらに、MDX（Markdown + JSX）もサポートしており、Markdown内でコンポーネントを使用することも可能です。

### 4. Content Collections

Astro 2.0から導入された「Content Collections」は、コンテンツの型安全性を保証する機能です。TypeScriptでスキーマを定義することで、フロントマターの型チェックが可能になります。

```typescript
// src/content/config.ts
import { defineCollection, z } from 'astro:content';

const blogCollection = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).optional(),
  }),
});

export const collections = {
  blog: blogCollection,
};
```

これにより、記事のメタデータに不備があればビルド時にエラーとして検出できます。

## プロジェクト構成

Astroプロジェクトの基本的なディレクトリ構造は以下のようになります。

```
my-blog/
├── public/           # 静的ファイル（画像、favicon等）
├── src/
│   ├── components/   # 再利用可能なコンポーネント
│   ├── content/      # ブログ記事などのコンテンツ
│   │   └── blog/     # ブログ記事のMarkdownファイル
│   ├── layouts/      # ページレイアウト
│   ├── pages/        # ルーティング（ファイルベース）
│   └── styles/       # グローバルスタイル
├── astro.config.mjs  # Astro設定ファイル
├── package.json
└── tsconfig.json
```

`src/pages/` ディレクトリ内のファイルは自動的にルートとして認識されます。例えば：

- `src/pages/index.astro` → `/`
- `src/pages/about.astro` → `/about`
- `src/pages/blog/[...slug].astro` → `/blog/記事スラッグ`

## パフォーマンスの比較

Astroで構築したサイトは、他のフレームワークと比較して優れたパフォーマンスを発揮します。

| 指標 | Astro | Next.js (SSG) | Gatsby |
|------|-------|---------------|--------|
| 初回ロード時のJS | 0KB〜 | 70KB〜 | 80KB〜 |
| ビルド時間 | 高速 | 中程度 | 遅い |
| Lighthouse スコア | 95-100 | 80-95 | 75-90 |

※ 数値は一般的な傾向であり、実際のプロジェクトにより異なります

## 実際の開発フロー

### 1. プロジェクトの作成

```bash
npm create astro@latest my-blog
cd my-blog
npm install
```

### 2. 開発サーバーの起動

```bash
npm run dev
```

### 3. 記事の作成

`src/content/blog/` ディレクトリに新しいMarkdownファイルを作成するだけです。

### 4. ビルドとデプロイ

```bash
npm run build
```

生成された `dist/` ディレクトリを、Vercel、Netlify、Cloudflare Pagesなどにデプロイします。
今回私は[Cloudflare pages](https://www.cloudflare.com/ja-jp/developer-platform/products/pages/)を使ってシュッとデプロイしました。

## まとめ
色々書きましたが、一言でいうと「軽量かつシンプルで書きやすく、他フレームワークからの移行も楽ちん」という部分がナイスな点と感じて今回ブログ構築にAstroを選びました。

「もしあなたがHTMLを知っているなら、あなたはすでに最初のAstroコンポーネントを書くのに十分な知識を持っています。」という一言も、開発者の目線から見てgoodだなと思いました。

ゆるく記事投稿続けていきたいなと思います。