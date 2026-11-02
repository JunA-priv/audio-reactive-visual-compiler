# 音源分離モデル重みの利用許諾調査

調査日：2026-10-31（read-only）  
対象：Deezer Spleeter公式4stems、SIGSEP Open-Unmix公式UMX-HQ、Demucs `htdemucs`（比較基準）

## 判定要約

| 項目 | Spleeter 4stems | Open-Unmix UMX-HQ | Demucs htdemucs |
|---|---|---|---|
| 権利者・正式配布元 | Deezer / 公式Spleeter repoが案内する公式モデル配布。重み個別の権利者表示はなし | Zenodo record作者Fabian-Robert Stöter、Antoine Liutkus（Inria所属）。SIGSEP公式repoとZenodo 3370489 | Demucs作者・Meta/Facebook Research配布。maintainerがIssue #327で重み条件を回答 |
| 重み自体のライセンス | 2020 JOSS論文はコードと事前学習モデル双方をMITと明記。一方現READMEは「code」のみMIT、LICENSEは重みを個別に特定しない。食い違いあり | Zenodo recordのRights/License欄は空。公式READMEはコードをMITとし、`umxl`だけ重みをCC BY-NC-SA 4.0と明記。UMX-HQ重み固有の許諾は未確認 | maintainer回答は「重みはMIT対象外、scientific purposesのみ」 |
| 商用利用 | 論文を重みに適用するならMITで可能との有力な解釈だが、現在の公式表記が曖昧。確定とは判定しない | 許諾未確認。商用可としない。`umxl`のNC条件をUMX-HQへ流用しない | scientific-purpose限定。商用不可として扱う |
| 一般公開Webサービスのサーバー推論 | 論文のMIT記述に依拠すれば可能との解釈余地はあるが、公式README/Issueに明確な確認なし。確定保留 | 許諾未確認 | 許諾なし。公開サービス用途に使わない |
| 重み再配布 | MITが適用されるならnotice付きで可能との解釈。ただし重みへの適用範囲が未解決 | Zenodoで取得可能であることは再配布許諾ではない。権利未確認 | 再配布許諾なし |
| 派生形式への変換 | MITが適用されるなら改変可能との解釈。ただしONNX/Core ML/MLX等の変換物の配布は公式未確認 | 変換・変換物配布とも未確認 | 変換配布の許諾なし |
| 著作権表示・ライセンス表記 | MIT適用時は著作権表示とMIT本文を複製・再配布物に保持する必要。重み固有のnoticeは未確認 | 重み条件が未確認のため義務も未確定。コードのMIT noticeはコード再配布時に保持 | 有効な重み再配布ライセンスがない。表示を付しても許諾の代わりにならない |
| CPU適合性 | JOSS論文がCPUまたはGPU実行可能と明記 | PyTorch実装のdevice指定から技術上CPU実行可能と判断。個別計測なし | 公式READMEにCPU指定あり。Python IslandでCPU推論実測済み |

**リリース判断：** この3モデルのうち、商用公開または一般公開Webサービス利用の条件を明瞭に確定できたモデルはない。Spleeterは論文が重みをMITと明記する有力な根拠を持つが、現READMEのcode-only表現や公式Issueの未回答質問との不一致が残る。UMX-HQは重みライセンスが明示されない。Demucsはscientific-purpose限定のmaintainer回答がある。これは一次資料に基づく審査上の判断であり、法律意見ではない。

## 一次資料で確認できたこと

### Spleeter公式4stems

- [JOSS 2020論文](https://www.theoj.org/joss-papers/joss.02154/10.21105.joss.02154.pdf)は、Distribution節でSpleeter source codeとpre-trained modelsがGitHub上でMIT licenseの下に配布されると明記する。公式4stemsモデルの存在、Deezer内部データで学習したこと、TensorFlow実装がCPUまたはGPUで実行できることも記載する。
- [公式README](https://github.com/deezer/spleeter)は2/4/5 stemsモデルが含まれると記載するが、License欄では「The code of Spleeter is MIT-licensed」と書き、重みを明示しない。 [LICENSE](https://github.com/deezer/spleeter/blob/master/LICENSE)は標準MIT本文で、どのモデルファイルが対象かを特定する補足はない。
- 重みはDeezer公式Spleeterローダーが取得するモデル配布物である。4stemsの設定は公式repoの[4stems.json](https://github.com/deezer/spleeter/blob/master/spleeter/resources/4stems.json)、モデル取得と利用経路は[公式モデルコード](https://github.com/deezer/spleeter/blob/master/spleeter/model/__init__.py)にある。配布物の実体・hashはダウンロードしていない。
- [Issue #898](https://github.com/deezer/spleeter/issues/898)は重みの商用利用について質問。確認時点でmaintainerからの回答はなく、追加コメントも同様の明確化を求めるもの。
- [Issue #957](https://github.com/deezer/spleeter/issues/957)は重みの商用利用、Core ML/MLX変換と配布を質問。投稿者は回答を受けていないとコメントしている。
- [Issue #959](https://github.com/deezer/spleeter/issues/959)はJOSS論文、README、LICENSE間の記述差を示し、repoの重みが商用利用を含めMIT対象か質問。調査時点で権利者回答は確認できない。
- READMEは著作権保護音源について権利者の適切な許諾を得るよう注意する。モデル許諾は入力音源や出力stemの著作権処理を代替しない。

### SIGSEP Open-Unmix公式UMX-HQ

- [公式Zenodo record 3370489](https://zenodo.org/records/3370489)はUMX-HQのPyTorch weightsを掲げ、4つの`.pth`ファイル（bass、drums、other、vocals。各約35.6 MB）を列挙する。AuthorsはFabian-Robert Stöter、Antoine Liutkus、所属はInria。ページのRights/License欄は空で、重みのライセンス識別子は表示されない。
- [公式Open-Unmix PyTorch README](https://github.com/sigsep/open-unmix-pytorch)は実装repoをMITと表示し、UMX-HQがMUSDB18-HQで学習されたと説明する。重みについて「non-commercial use (CC BY-NC-SA 4.0)」と明記されるのは`umxl`だけ。
- [SIGSEP公式Open-Unmixサイト](https://sigsep.github.io/open-unmix/)も同様に、umxlだけの非商用条項を記載する。UMX-HQについて個別の明示ライセンスは確認できない。umxlの条項をUMX-HQへ適用する根拠も、UMX-HQに商用許諾があると断定する根拠もない。
- 公式[MUSDB18データセット案内](https://sigsep.github.io/datasets/musdb.html)はMUSDB18全体へのアクセスをacademic purposesに限定し、含まれる一部楽曲の条件としてCC BY-NC-SAを列挙する。学習データ条件が重みにどう及ぶかを本調査資料だけで決着できないが、重みライセンスの欠落を埋める許諾ではない。
- Open-UnmixのMITコードライセンス、重みのZenodo公開、各チェックポイントの重みライセンスはそれぞれ別個の事実として扱う。一般公開・商用推論、重み再配布、形式変換の許可はいずれも確認できない。

### Demucs htdemucs

- [公式Issue #327](https://github.com/facebookresearch/demucs/issues/327)のmaintainer回答（2022-05-23）は「model weights are not covered by the MIT license, and are provided only for scientific purposes」と明記。
- [公式README](https://github.com/facebookresearch/demucs)は`htdemucs`を既定の4-stemモデルとして説明し、CPU指定`-d cpu`を案内する。学習はMUSDBと追加800曲と記載する。
- Issue内の別投稿者によるMUSDB条件の説明はmaintainerの回答ではなく、利用許諾を拡張するものではない。商用・公開サービス、重み再配布、変換物配布を認める別ライセンスは確認できない。
- 既存[Python Island報告](2026-10-31-python-island.md)はCPU htdemucsの技術動作を記録済み。技術的に実行できることは商用利用許諾を意味しない。

## 評価の解釈と未確認事項

1. GitHubのrepo license badgeやコード用MIT LICENSEだけで、別配布のバイナリ重みまでカバーするとは断定しない。
2. Zenodo recordからダウンロードできることは、再配布・商用利用・変換配布の許可ではない。Zenodo自身もrecordのRights欄に従うと説明している（[Zenodo FAQ](https://support.zenodo.org/help/en-gb/2-content/21-can-i-get-permission-to-use-a-specific-record)）。
3. MUSDBの学習データ条件が派生重みへ及ぼす法的効果は本報告では決定していない。Open-Unmix/Demucsでは重み固有の許諾確認がなお必要。
4. 重みをダウンロードしてhash、内容、metadata、変換再現性を調べることはしていない。ユーザー指示によりダウンロードは行わなかった。
5. Deezerへの外部問い合わせは行っていない。Issue #898/#957/#959は公開記載を読み取り、権利者回答を確認できなかったことを記録した。
6. ライセンス表示義務の評価はモデル資産に関するもの。入力楽曲・出力stemの権利処理を含まない。

## 公開利用のゲート

- **Spleeter 4stems：** 公式重みファイルへのMIT適用範囲と、ONNX等への変換・配布を明瞭に確認できる一次資料が得られるまで商用/一般公開承認を保留。
- **UMX-HQ：** ZenodoまたはSIGSEPから重み固有ライセンスが確認できるまで、商用/一般公開/再配布/変換配布を承認しない。
- **Demucs htdemucs：** scientific-purpose限定を覆す個別の許諾がない限り、商用・公開サービスへ投入しない。

## 参照した一次資料

- [Spleeter JOSS 2020論文](https://www.theoj.org/joss-papers/joss.02154/10.21105.joss.02154.pdf)
- [Deezer/Spleeter公式repo・README](https://github.com/deezer/spleeter)
- [Spleeter LICENSE](https://github.com/deezer/spleeter/blob/master/LICENSE)
- [Spleeter Issue #898](https://github.com/deezer/spleeter/issues/898)、[#957](https://github.com/deezer/spleeter/issues/957)、[#959](https://github.com/deezer/spleeter/issues/959)
- [SIGSEP Open-Unmix PyTorch公式repo](https://github.com/sigsep/open-unmix-pytorch)
- [UMX-HQ Zenodo record 3370489](https://zenodo.org/records/3370489)
- [SIGSEP Open-Unmix公式サイト](https://sigsep.github.io/open-unmix/)
- [SIGSEP MUSDB18データセット条件](https://sigsep.github.io/datasets/musdb.html)
- [Demucs maintainer Issue #327](https://github.com/facebookresearch/demucs/issues/327)
- [Demucs公式repo/README](https://github.com/facebookresearch/demucs)
