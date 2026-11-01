import { Hono } from 'hono';
import { pool } from '../../config/drizzle.js';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';

const router = new Hono();

const DEFAULT_CONTENT = {
  hero: {
    badge: "Imejengwa Tanzania — Maduka 100+ nchini kote",
    title: "Mfumo Mahiri wa\nKuendesha Biashara Yako",
    titleHighlight: "Kuendesha Biashara Yako",
    subtitle: "ALFEAN ENTERPRISES ni mfumo kamili wa POS unaofaa kwa kila aina ya biashara — vifaa, nguo, electronics, vifaa vya nyumbani, na zaidi. Rekodi mauzo, fuatilia hesabu, dhibiti madeni na gharama zote sehemu moja.",
    englishSubtitle: "The all-in-one POS system for every shop — hardware, clothing, electronics, home supplies & more. Sales, inventory, debts & expenses. Works offline.",
    ctaText: "Anza Bure Sasa",
    ctaLink: "/register",
    secondaryText: "Tazama Vipengele",
    shopTypes: ["Vifaa", "Nguo", "Electronics", "Nyumbani", "Zaidi"],
    trustBadges: ["Hakuna kadi inahitajika", "Siku 30 bila malipo", "Ghairi wakati wowote"]
  },
  features: {
    badge: "Vipengele",
    title: "Kila Kitu Unachohitaji",
    titleHighlight: "Kuendesha Biashara Yako",
    subtitle: "ALFEAN ENTERPRISES inafaa kwa kila aina ya biashara — maduka ya vifaa, nguo, electronics, vifaa vya nyumbani, na zaidi. Mauzo, hesabu, madeni, gharama na ripoti zote sehemu moja.",
    items: [
    {
      icon: "ShoppingCart",
      title: "POS & Mauzo",
      desc: "Piga risiti kwa sekunde kwa kila bidhaa. Tumia barcode, pima kwa kilo/mita/kipande. Offline mode inakuwezesha kuuza hata bila mtandao.",
      endesc: "Issue receipts in seconds for any product. Scan barcodes, sell by piece/kg/meter. Works offline."
    },
    {
      icon: "Package",
      title: "Hesabu ya Bidhaa",
      desc: "Fuatilia hesabu kwa wakati halisi kwa aina yoyote ya bidhaa. Pokea tahadhari bidhaa zikiisha. Simamia maghala na maduka zaidi ya moja.",
      endesc: "Real-time inventory for any product type. Low-stock alerts. Manage multiple shops and warehouses."
    },
    {
      icon: "BarChart3",
      title: "Ripoti & Takwimu",
      desc: "Ripoti za mauzo, faida na gharama kwa siku, wiki, mwezi na mwaka. Grafu zinazoonesha mwenendo wako na bidhaa zinazouza vizuri.",
      endesc: "Sales, profit & expense reports by day/week/month/year. Visual charts showing trends and top sellers."
    },
    {
      icon: "Users",
      title: "Madeni & Wateja",
      desc: "Rekodi madeni ya wateja kwa urahisi, tuma vikumbusho otomatiki. Fuatilia historia ya malipo na miamala ya kila mteja.",
      endesc: "Track customer debts easily, auto-send reminders. View payment history and transaction logs."
    },
    {
      icon: "TrendingUp",
      title: "Gharama za Biashara",
      desc: "Andika gharama zote — usafiri, kodi, mishahara, ununuzi wa bidhaa, na zaidi. Jua faida halisi baada ya gharama zote.",
      endesc: "Log every expense — transport, rent, salaries, stock purchases. See net profit after all costs."
    },
    {
      icon: "Smartphone",
      title: "Simu & Tablet",
      desc: "Inafanya kazi kwenye simu, tablet na kompyuta. Chapisha risiti kwa printer ya Bluetooth. Hifadhi data cloud otomatiki. Hakuna mtandao? Bado unaweza kuuza.",
      endesc: "Works on phone, tablet & computer. Bluetooth printing. Auto cloud backup. No internet? Still sell."
    },
    {
      icon: "Truck",
      title: "Wauzaji & Manunuzi",
      desc: "Simamia wauzaji wako, oda, kupokea bidhaa na malipo yao. Fuatilia madeni ya wauzaji na ripoti za manunuzi.",
      endesc: "Manage suppliers, purchase orders, goods received and payments. Track supplier debts and purchase reports."
    },
    {
      icon: "ClipboardCheck",
      title: "Ukaguzi wa Stock",
      desc: "Fungua kikao cha kuhesabu bidhaa, linganisha stock ya mfumo na halisi, rekodi tofauti na idhini ya marekebisho.",
      endesc: "Run stock count sessions, compare system vs physical stock, record variances and approve adjustments."
    },
    {
      icon: "Bot",
      title: "AI, SMS & Email",
      desc: "Msaidizi wa AI anayekusaidia kuuza na kuchambua, SMS na email kwa wateja wako — zote ndani ya mfumo mmoja.",
      endesc: "AI assistant for selling & insights, plus SMS and email campaigns — all in one system."
    }
    ]
  },
  featureDetails: {
    badge: "Vipengele Vyote",
    title: "Kila Kipengele cha ALFEAN ENTERPRISES",
    titleHighlight: "Kwa Kina",
    subtitle: "ALFEAN ENTERPRISES si POS tu — ni mfumo kamili wa kuendesha biashara yako. Hapa chini ni kila kipengele kilichojengwa kwa mahitaji ya maduka ya Tanzania, kikiwa na maelezo ya kina ili ujue mfumo mzima kabla ya kuanza.",
    englishSubtitle: "Every ALFEAN ENTERPRISES feature explained in depth — from selling and stock to debts, reports, SMS, AI and security.",
    stats: [
      { value: "25+", label: "Moduli kamili" },
      { value: "150+", label: "Vipengele" },
      { value: "2", label: "Lugha: SW / EN" },
      { value: "30", label: "Siku bure" }
    ],
    groups: [
      {
        icon: "ScanBarcode",
        title: "Uuzaji — POS ya Kisasa",
        desc: "Uza kwa kasi, kwa usahihi na kwa njia yoyote anayotumia mteja wako.",
        endesc: "Fast, accurate selling with every payment method your customers use.",
        items: [
          "POS ya haraka (Fast POS): orodha ya bidhaa kwa safu na nguzo (rows & columns) inayoonekana vizuri kwenye simu — utafutaji wa papo hapo na mbofyo mmoja kuongeza kwenye kikapu.",
          "Utafutaji wa bidhaa kwa jina, SKU, barcode au kundi — unaona stock na bei kabla ya kuuza.",
          "Skana barcode na QR kwa kamera ya simu au kifaa cha kusoma barcode.",
          "Kuuza kwa kipande, kilo, gramu, mita, mita za mraba (m²), tani, boksi, roll na vitengo vyako maalum.",
          "Uuzaji wa bidhaa za vipimo (mbao, mabati, vitambaa): ingiza urefu × upana, mfumo hukokotoa eneo na bei yenyewe.",
          "Mauzo ya sehemu (fractions): nusu, robo, theluthi na sehemu maalum za bidhaa.",
          "Punguzo kwa bidhaa moja kwenye kikapu au kwa risiti nzima.",
          "Njia za malipo: pesa taslimu, Lipa Namba, benki (NMB, CRDB na nyingine) na mauzo ya deni.",
          "Kikokotoo cha chenji na vitufe vya haraka vya kiasi (TSh 1,000, 5,000, 10,000 na zaidi).",
          "Risiti za kitaalamu zenye logo na maelezo ya duka — chapisha kwa printer ya Bluetooth au andika kwa mkono.",
          "Weka tarehe ya nyuma (backdate) kwa mauzo ya siku zilizopita ili yajitokeze kwenye ripoti za siku husika.",
          "Chagua mteja aliyesajiliwa au ongeza mteja mpya papo hapo wakati wa mauzo.",
          "Mapendekezo ya AI yanayoonyesha bidhaa zinazonunuliwa pamoja (cross-sell).",
          "Uuzaji kwa mazungumzo: andika maelezo kwa Kiswahili, mfumo ukamilishe mauzo yenyewe.",
          "Inafanya kazi bila mtandao (offline) — mauzo husawazishwa mtandao ukirudi."
        ]
      },
      {
        icon: "Receipt",
        title: "Mauzo na Historia ya Mauzo",
        desc: "Kila muamala umehifadhiwa — kagua, chuja, pakua risiti na fuatilia faida kwa urahisi.",
        endesc: "Every transaction is saved — review, filter, download receipts and track profit with ease.",
        items: [
          "Orodha ya mauzo yote: tarehe, saa, bidhaa, njia ya malipo, muuzaji na kiasi.",
          "Vichujio vya tarehe (kuanzia–kuishia) kwa kuona mauzo ya siku, wiki au mwezi wowote.",
          "Takwimu za haraka: idadi ya miamala, mapato, faida, taslimu na malipo ya simu.",
          "Angalia maelezo kamili ya mauzo: bidhaa, wingi, bei ya kununua, bei ya kuuza, punguzo na faida.",
          "Pakua au chapisha risiti ya muamala wowote (PDF) wakati wowote.",
          "Futa muamala kwa ruhusa maalum ya msimamizi.",
          "Kurasa (pagination) na ukubwa wa kurasa unaobadilika kwa maduka yenye mauzo mengi.",
          "Mauzo ya offline yanaonekana hapa yakisawazishwa mtandao ukirudi."
        ]
      },
      {
        icon: "Boxes",
        title: "Bidhaa na Usimamizi wa Ghala",
        desc: "Jua kila bidhaa uliyonayo, kiasi chake, bei yake na faida yake — wakati wowote.",
        endesc: "Know every product, its stock, price and profit — at any time.",
        items: [
          "Usajili wa bidhaa bila kikomo: jina, SKU, barcode, QR, maelezo na picha.",
          "Bei za kununua na kuuza, pamoja na gharama kwa kila kipimo (cost per qty).",
          "Makundi ya bidhaa (categories) yenye rangi, maelezo na mpangilio rahisi wa kutafuta.",
          "Kuagiza bidhaa nyingi kwa faili (Excel/CSV import) na kuhariri au kufuta kwa mpigo (bulk actions).",
          "Kutengeneza na kuchapisha barcode/QR code kwa bidhaa zako kwa printer.",
          "Kubadilisha vipimo vya bidhaa (unit conversions) na bei tofauti kwa kila kipimo.",
          "Hesabu ya stock kwa desimali (mfano 10.5 kg) kwa bidhaa za uzito, urefu na eneo.",
          "Kiwango cha chini cha stock (low stock) na tahadhari otomatiki bidhaa inapokaribia kuisha.",
          "Ufuatiliaji wa tarehe ya kumalizika (expiry) kwa bidhaa zinazoharibika.",
          "Uingizaji wa mzigo (cargo): rekodi mzigo, gharama ya usafiri na faida halisi ya mzigo.",
          "Ukaguzi wa stock (stock take): fungua kikao cha kuhesabu, linganisha stock ya mfumo na halisi, rekodi tofauti na idhini.",
          "Marekebisho ya stock (stock adjustments) yenye sababu na kumbukumbu ya aliyefanya.",
          "Vitengo vya vipimo: PCS, KG, MTR, SQM, TON, BOX, ROLL, SET, LTR na vitengo vyako maalum.",
          "Wauzaji (suppliers): oda, kupokea bidhaa, malipo, madeni ya wauzaji na ripoti zao.",
          "Tahadhari za bidhaa zinazokwisha muda na zinazohitaji kuagizwa tena."
        ]
      },
      {
        icon: "Users",
        title: "Wateja",
        desc: "Rejista kamili ya wateja wako pamoja na tabia zao za manunuzi.",
        endesc: "A complete customer registry with their buying behaviour.",
        items: [
          "Rejista ya wateja wote: jina, simu, barua pepe, kampuni, TIN/VRN na anwani.",
          "Takwimu za kila mteja: jumla ya manunuzi, idadi ya ziara na tarehe ya mwisho kununua.",
          "Utafutaji wa mteja kwa jina au simu — pia wakati wa mauzo na kwenye ankara.",
          "Fuatilia wateja waliorejesha bidhaa (returns).",
          "Ongeza, hariri au futa mteja kwa urahisi.",
          "Wateja hutumika kwenye SMS, simu, ankara na madeni."
        ]
      },
      {
        icon: "Coins",
        title: "Madeni (Deni)",
        desc: "Dhibiti kila deni kwa daftari kamili — hakuna deni linalopotea.",
        endesc: "Control every debt with a complete ledger — nothing gets lost.",
        items: [
          "Daftari (ledger) ya kila mteja: bidhaa alizochukua, kiasi, tarehe na salio.",
          "Malipo kwa bidhaa moja moja au kwa deni zima kwa mbofyo mmoja.",
          "Malipo ya sehemu (partial) na punguzo (discount) wakati wa kulipa.",
          "Historia kamili ya malipo na salio la kila mteja kwa wakati halisi.",
          "Vikumbusho vya malipo kwa SMS otomatiki na ujumbe wa simu wenye taarifa kamili ya deni.",
          "Risiti na taarifa ya deni (PDF) yenye bidhaa, malipo na salio — tuma kwa mteja moja kwa moja.",
          "Utafutaji wa haraka wa mdaiwa kwa jina au namba ya simu hata ukiwa na wadeni wengi.",
          "Rejista ya wateja: mawasiliano, kampuni, TIN/VRN kwa ankara na takwimu za manunuzi.",
          "Fuatilia wateja wanaorudisha bidhaa na idadi ya ziara zao.",
          "Ongeza deni jipya la mteja akiwa dukani au kwa kumbukumbu za nyuma."
        ]
      },
      {
        icon: "Truck",
        title: "Wasambazaji na Manunuzi",
        desc: "Simamia wasambazaji, oda za manunuzi, kupokea bidhaa na malipo yao.",
        endesc: "Manage suppliers, purchase orders, goods received and their payments.",
        items: [
          "Rejista ya wasambazaji: jina, simu, kampuni, anwani na maelezo.",
          "Oda za manunuzi (purchase orders): tengeneza oda na fuatilia hali yake.",
          "Kupokea bidhaa (receive goods) na kusasisha stock moja kwa moja.",
          "Malipo kwa wasambazaji na historia kamili ya malipo.",
          "Madeni ya wasambazaji — jua unadaiwa kiasi gani na kwa msambazaji yupi.",
          "Ripoti za manunuzi kwa msambazaji na kipindi maalum."
        ]
      },
      {
        icon: "Calculator",
        title: "Matumizi, Mapato na Faida",
        desc: "Jua pesa inaingia wapi na inatoka wapi — faida halisi, si makisio.",
        endesc: "See exactly where money comes in and goes out — real profit, not guesswork.",
        items: [
          "Matumizi: rekodi gharama zote — kodi, umeme, maji, mishahara, usafiri, matangazo, bima na kodi za serikali.",
          "Kategoria za matumizi zinazoweza kubadilishwa pamoja na kategoria zako mpya.",
          "Mgawanyo wa mishahara kwa kila mfanyakazi kwenye gharama moja.",
          "Kipindi cha gharama (kuanzia–kuishia) kwa ripoti za mwezi.",
          "Mapato (Earnings): mapato yote, faida ghafi, matumizi na faida halisi kwa mwezi.",
          "Faida kwa kila bidhaa na kwa kila mauzo — jua bidhaa zinazokuletea faida zaidi.",
          "Grafu za mapato, faida na matumizi kwa muda.",
          "Kokotoa faida halisi (net profit) baada ya kutoa gharama zote.",
          "Rekodi gharama za mzigo na usafiri kwenye hesabu ya faida."
        ]
      },
      {
        icon: "LineChart",
        title: "Ripoti na Uchambuzi",
        desc: "Kila namba unayohitaji kufanya maamuzi bora ya biashara — kwa grafu rahisi kueleweka.",
        endesc: "Every number you need to make better business decisions — in easy-to-read charts.",
        items: [
          "Dashibodi ya leo: mauzo, faida, oda, madeni, bidhaa na mapato kwa mtazamo mmoja.",
          "Dashibodi ya moja kwa moja: mauzo ya saa 24, bidhaa zilizoisha (low stock alerts), mauzo ya karibuni na matumizi ya mwezi.",
          "Ripoti za mauzo na faida kwa siku, wiki, mwezi, mwaka au kipindi maalum.",
          "Grafu za mwenendo wa mauzo na faida kwa muda.",
          "Bidhaa zinazouza zaidi na zenye faida kubwa.",
          "Mchanganuo wa njia za malipo: taslimu, benki, Lipa Namba na deni.",
          "Ripoti za gharama na faida halisi ya kipindi.",
          "Ripoti za wauzaji, huduma, madeni na oda za mapema.",
          "Ripoti kwa kila muuzaji (seller) ili kupima utendaji wa timu.",
          "Hamisha ripoti kwa Excel (XLSX), CSV au PDF kwa uchambuzi zaidi."
        ]
      },
      {
        icon: "Wrench",
        title: "Huduma, Oda na Ankara",
        desc: "Uza bidhaa na huduma, pokea oda za mapema na toa ankara za kitaalamu.",
        endesc: "Sell products and services, take pre-orders and issue professional invoices.",
        items: [
          "Huduma (services): usajili wa huduma na kategoria zake — mfano kukata mbao, kuchomelea, kusafirisha.",
          "Rekodi za huduma zilizotolewa, gharama, mteja na mapato yake.",
          "Ripoti za huduma kwa kipindi — jua huduma zipi zinakuletea mapato zaidi.",
          "Oda za mapema (pre-orders): fuatilia maagizo, amana zilizotolewa na tarehe ya kutarajia.",
          "Kamilisha oda, rekodi malipo na fuatilia salio la kila oda.",
          "Ankara za kitaalamu zenye namba ya ankara, TIN/VRN ya mteja, benki na maelezo ya duka.",
          "Fuatilia malipo ya ankara kwa sehemu na salio la kila ankara.",
          "Chapisha au pakua ankara na risiti kwa PDF."
        ]
      },
      {
        icon: "MessageSquare",
        title: "SMS, Email na Arifa",
        desc: "Wasiliana na wateja wako moja kwa moja kutoka kwenye mfumo — bila programu nyingine.",
        endesc: "Reach your customers directly from the system — no extra apps needed.",
        items: [
          "Kituo cha SMS: nunua salio la SMS ndani ya mfumo na tuma ujumbe kwa gharama nafuu.",
          "Bulk SMS: tuma ujumbe kwa wateja wengi kwa mpigo — chagua kikundi au weka namba mwenyewe.",
          "Makundi ya wateja (contacts/groups) kwa kampeni zenye lengo.",
          "Violezo vya SMS (templates) na msaidizi wa AI kuandika ujumbe wako.",
          "Kampeni za SMS zenye ratiba, kufuatilia utumaji na kughairi.",
          "Sender ID yako mwenyewe ili wateja watambue jina la duka lako.",
          "Auto SMS baada ya kila mauzo: mteja anapokea ujumbe wa shukrani wenye jumla — unaweza kuwasha, kuzima na kubadilisha maneno.",
          "Vikumbusho vya madeni kwa SMS otomatiki na vikumbusho vya malipo kwa wateja.",
          "Historia ya SMS zote, matumizi na manunuzi ya salio.",
          "Barua pepe (email): kampeni, violezo (templates) na ufuatiliaji wa kufunguliwa na kubofya.",
          "Arifa za ndani (notifications) na arifa za simu kwa matukio muhimu."
        ]
      },
      {
        icon: "Bot",
        title: "AI ya Biashara",
        desc: "Msaidizi wa akili bandia anayekusaidia kuuza, kuchambua na kukua.",
        endesc: "An AI assistant that helps you sell, analyse and grow.",
        items: [
          "Msaidizi wa ALFEAN ENTERPRISES (AI Advisor): uliza maswali kama 'Bidhaa gani ninunue zaidi?' na upate majibu kwa lugha rahisi.",
          "Mapendekezo ya bidhaa za kuuza pamoja (cross-sell) kwa kila mauzo.",
          "Uuzaji kwa mazungumzo (AI Sale Chat) — andika tu maelezo, mfumo hukamilisha oda.",
          "AI kuandika ujumbe wa SMS na kampeni za wateja.",
          "Uchambuzi wa mauzo, faida na tabia za wateja kwa maamuzi bora."
        ]
      },
      {
        icon: "ShieldCheck",
        title: "Usimamizi, Usalama na Backup",
        desc: "Mfumo salama wenye udhibiti kamili wa watumiaji, maduka na data yako.",
        endesc: "A secure system with full control of users, shops and your data.",
        items: [
          "Maduka mengi (multi-shop) chini ya akaunti moja — kila duka na stock na ripoti zake, na kubadilisha duka kwa mbofyo mmoja.",
          "Watumiaji wasio na kikomo: wauzaji na wasimamizi, kila mmoja na ruhusa zake.",
          "Ruhusa za kina (permissions): nani anaweza kuuza, kubadilisha bei, kuona ripoti au kufuta taarifa.",
          "Usajili wa akaunti, kuingia salama (login), kuweka upya neno la siri na uthibitisho wa barua pepe.",
          "Kumbukumbu za matukio (activity logs): nani alifanya nini na lini.",
          "Historia ya kuingia (login history) na vikao vya watumiaji kwa usalama.",
          "Ufuatiliaji wa makosa ya mfumo (system errors) kwa msaada wa haraka.",
          "Mipangilio ya duka: jina la biashara, tawi, namba ya serial, logo na maelezo ya risiti.",
          "Msaada wa moja kwa moja (support chat) na mrejesho (feedback) ndani ya mfumo.",
          "Usajili wa mfumo (subscription): mipango, siku za bure na malipo kwa M-Pesa/Lipa Namba.",
          "Backup za otomatiki kwenye cloud, historia ya backup na urejeshaji (restore) wa data.",
          "Lugha mbili: Kiswahili na Kiingereza — badilisha wakati wowote.",
          "Ufuatiliaji wa utendaji wa mfumo (performance monitoring) kwa kasi ya kuaminika."
        ]
      },
      {
        icon: "Smartphone",
        title: "Kifaa, Offline na Ufikiaji",
        desc: "Tumia ALFEAN ENTERPRISES kwenye kifaa chochote, mahali popote — mtandao ukiwepo au la.",
        endesc: "Use ALFEAN ENTERPRISES on any device, anywhere — with or without internet.",
        items: [
          "Inafanya kazi kwenye simu, tablet na kompyuta bila kufunga programu ngumu.",
          "Hali ya offline: uza, ongeza bidhaa na rekodi madeni bila mtandao; data husawazishwa mtandao ukirudi.",
          "Kasi ya juu hata kwenye simu za kawaida kwa sababu ya uboreshaji wa data.",
          "Sakinisha kama programu (PWA) kwenye skrini ya nyumbani ya simu yako.",
          "Inatumika vizuri kwa kidole kimoja — vitufe vikubwa na mpangilio rahisi kwa simu.",
          "Msaada wa simu na mwongozo wa video kwa Kiswahili."
        ]
      }
    ]
  },
  screenshots: {
    badge: "Picha za Mfumo",
    title: "Angalia Jinsi Mfumo Wetu Unavyoonekana",
    titleHighlight: "Mfumo Wetu",
    subtitle: "Skrini za mfumo halisi zinazoonesha jinsi ALFEAN ENTERPRISES inavyofanya kazi kwenye maduka mbalimbali.",
    englishSubtitle: "Actual system screens showing how ALFEAN ENTERPRISES works across different types of shops.",
    items: [
      { id: "pos", label: "POS & Mauzo", desc: "Skrini ya mauzo — ongeza bidhaa, chagua wingi, chapisha risiti kwa sekunde. Inafanya kazi offline.", imageUrl: "" },
      { id: "products", label: "Bidhaa", desc: "Usimamizi wa bidhaa zako zote. Panga kwa kategoria, weka bei, tumia barcode.", imageUrl: "" },
      { id: "reports", label: "Ripoti", desc: "Ripoti za mauzo na faida kwa grafu. Jua biashara yako inavyokua kwa mtazamo mmoja.", imageUrl: "" },
      { id: "customers", label: "Wateja", desc: "Rekodi za wateja na madeni yao. Tuma vikumbusho na fuatilia malipo.", imageUrl: "" }
    ]
  },
  howItWorks: {
    badge: "Jinsi Inavyofanya Kazi",
    title: "Anza Kwa",
    titleHighlight: "Hatua Nne",
    titleEnd: "Rahisi",
    subtitle: "Hakuna utata. Hakuna mafunzo ya muda mrefu. Fungua akaunti na anza kuuza leo.",
    items: [
    {
      num: "01", icon: "Layers",
      title: "Jiandikishe Bure",
      desc: "Fungua akaunti kwa siku 30 bila malipo. Hakuna kadi inayohitajika. Anza kutumia ndani ya dakika 2.",
      endesc: "Sign up free for 30 days. No card required. Start in 2 minutes."
    },
    {
      num: "02", icon: "Package",
      title: "Ingiza Bidhaa Zako",
      desc: "Ongeza bidhaa kwa barcode, jina, au kuleta faili. Weka bei za jumla na rejareja kwa urahisi.",
      endesc: "Add products by barcode, name, or file import. Set wholesale & retail prices."
    },
    {
      num: "03", icon: "ShoppingCart",
      title: "Anza Kuuza",
      desc: "Chagua bidhaa, ingiza kiasi na ubandike risiti. Mauzo yanaingia kwenye ripoti moja kwa moja.",
      endesc: "Select items, enter quantity, print receipt. Sales auto-record into reports."
    },
    {
      num: "04", icon: "Target",
      title: "Fuatilia & Kua",
      desc: "Angalia ripoti za mauzo na faida. Pokea arifa bidhaa zikiisha. Simamia wateja na madeni. Kua biashara yako.",
      endesc: "View reports, get restock alerts, manage customers & debts. Grow your business."
    }
    ]
  },
  pricing: {
    badge: "Bei",
    title: "Chagua Mpango Unaofaa",
    titleHighlight: "Biashara Yako",
    subtitle: "Badilisha au ghairi wakati wowote. Hakuna mikataba ya muda mrefu.",
    paymentText: "Malipo: M-Pesa • Mixx (Yas) • Halopesa • Airtel Money • Card • QR",
    plans: [
      {
        name: "Mwezi 1",
        subtitle: "Monthly",
        price: "TSh 7,500",
        period: "/mwezi",
        popular: false,
        features: [
          "POS & mauzo kamili",
          "Hesabu ya bidhaa (hadi 1,000)",
          "Mauzo ya rejareja na jumla",
          "Ripoti za mauzo na faida",
          "Risiti za printer na mkono",
          "Madeni ya wateja",
          "Gharama za biashara",
          "Barcode scanning",
          "Msaada wa simu"
        ],
        cta: "Anza Sasa"
      },
      {
        name: "Miezi 3",
        subtitle: "Quarterly — husika 2,500",
        price: "TSh 20,000",
        period: "/miezi 3",
        popular: true,
        features: [
          "Vipengele vyote vya Mwezi 1",
          "Hesabu ya bidhaa (hadi 5,000)",
          "Ripoti za kina za mauzo",
          "Ripoti za gharama na faida halisi",
          "Usafirishaji data Excel/PDF",
          "Maduka hadi 2",
          "Backup cloud otomatiki",
          "Msaada simu + Simu",
          "Huduma ya kipaumbele"
        ],
        cta: "Anza Sasa"
      },
      {
        name: "Miezi 6",
        subtitle: "Semi-Annual — husika 5,833",
        price: "TSh 35,000",
        period: "/miezi 6",
        popular: false,
        features: [
          "Vipengele vyote vya Miezi 3",
          "Hesabu ya bidhaa (hadi 10,000+)",
          "Maduka hadi 5",
          "Ripoti za juu za usimamizi",
          "API integration",
          "Mafunzo ya ana kwa ana",
          "Msaada wa kipaumbele 24/7",
          "Ushauri wa biashara"
        ],
        cta: "Wasiliana"
      }
    ]
  },
  testimonials: {
    badge: "Wateja Wetu",
    title: "Watu Wanaotumia ALFEAN ENTERPRISES Wanasema",
    titleHighlight: "Wanasema",
    subtitle: "Jiunge na maduka 100+ yanayotumia ALFEAN ENTERPRISES kuendesha biashara zao kwa ufanisi.",
    items: [
      {
        name: "Juma Mohamed",
        shop: "Juma Hardware, Arusha",
        text: "Nimekuwa nikitumia ALFEAN ENTERPRISES kwa miezi 6. Nimependa jinsi inavyorahisisha kuuza na kuangalia hesabu. Kabla ya ALFEAN ENTERPRISES, nilikuwa nikiandika kwa daftari na napoteza mauzo mengi. Sasa ninajua kwa uhakika kiasi cha bidhaa na faida yangu."
      },
      {
        name: "Amina Salim",
        shop: "Salim Building Supplies, Dar",
        text: "ALFEAN ENTERPRISES imebadilisha kabisa biashara yangu. Kipengele cha madeni kimewanufaisha wateja na mimi. Wanakuja kujilipia kwa urahisi na mimi nina rekodi kamili. Ripoti za gharama zinanisaidia kuona pesa inakwenda wapi."
      },
      {
        name: "David Mwangi",
        shop: "Mwangi Hardware, Mwanza",
        text: "Nilianza na trial, sasa niko kwenye Msingi. Ninauza zaidi ya bidhaa 500 na ALFEAN ENTERPRISES inashughulikia vizuri. Offline mode ni muhimu sana kwani mtandao wetu si mzuri. Inafanya kazi vizuri kwenye tablet yangu."
      }
    ]
  },
  faq: {
    badge: "Maswali",
    title: "Maswali Yanayoulizwa Mara Kwa Mara",
    titleHighlight: "Mara Kwa Mara",
    items: [
      {
        q: "Je, ALFEAN ENTERPRISES inahitaji internet?",
        a: "Hapana. ALFEAN ENTERPRISES inafanya kazi offline kwenye mauzo na kurekodi data. Data itasawazishwa mtandao ukirudi. Unaweza kuuza hata sehemu zisizo na mtandao.",
        ea: "No. ALFEAN ENTERPRISES works offline for sales. Data syncs when internet is available. Sell in remote areas."
      },
      {
        q: "Je, naweza kutumia ALFEAN ENTERPRISES kwenye simu yangu?",
        a: "Ndiyo. ALFEAN ENTERPRISES inafanya kazi kwenye simu, tablet na kompyuta. Unaweza kuchapisha risiti kwa printer ya Bluetooth kutoka simu yako.",
        ea: "Yes. ALFEAN ENTERPRISES works on phone, tablet & computer. Print receipts via Bluetooth from your phone."
      },
      {
        q: "Je, kuna mafunzo ya kutumia ALFEAN ENTERPRISES?",
        a: "ALFEAN ENTERPRISES imebuniwa iwe rahisi kutumia bila mafunzo. Lakini tunatoa mwongozo wa video na msaada wa simu kwa wateja wote.",
        ea: "ALFEAN ENTERPRISES is designed to be easy. We provide video guides and simu support."
      },
      {
        q: "Naweza kubadilisha mpango wangu baadaye?",
        a: "Ndiyo. Unaweza kuboresha mpango wako wakati wowote. Tofauti ya bei itarekebishwa kwa siku zilizobaki za mwezi wako.",
        ea: "Yes. Upgrade anytime. Price difference is prorated for remaining days."
      },
      {
        q: "Je, data yangu iko salama?",
        a: "Ndiyo. Data inahifadhiwa kwa usalama kwenye cloud na backup mara kwa mara. Unaweza kupakua ripoti zako wakati wowote.",
        ea: "Yes. Data is securely stored in the cloud with regular backups."
      },
      {
        q: "Namna gani malipo ya usajili?",
        a: "Tunakubali M-Pesa, Mixx (Yas), Halopesa, Airtel Money, Card na QR code. Malipo ni salama na ya haraka.",
        ea: "We accept M-Pesa, Mixx (Yas), Halopesa, Airtel Money, Card and QR. Secure and instant."
      }
    ]
  },
  cta: {
    title: "Tayari Kupeleka Biashara Yako Kwenye Kiwango Kingine?",
    titleHighlight: "Kiwango Kingine",
    subtitle: "Jiandikishe leo na upate siku 30 bila malipo. Hakuna kadi inayohitajika. Hakuna mikataba. Ghairi wakati wowote.",
    ctaText: "Anza Bure Sasa",
    ctaLink: "/register",
    secondaryText: "Nina Akaunti Tayari",
    secondaryLink: "/login",
    trustBadges: ["Hakuna kadi", "Siku 30 bure", "Ghairi wakati wowote"]
  },
  footer: {
    description: "Mfumo mahiri wa POS kwa kila aina ya biashara. Imejengwa Tanzania, kwa ajili ya Tanzania.",
    englishDescription: "Smart POS for every type of business. Built in Tanzania.",
    siteName: "ALFEAN ENTERPRISES",
    phone: "+255 77 569 9545",
    email: "info@localhost",
    payments: ["M-Pesa", "Mixx (Yas)", "Halopesa", "Airtel Money", "Card", "QR"],
    aboutTitle: "Kuhusu",
    aboutLinks: ["Vipengele", "Picha za Mfumo", "Hatua", "Bei", "Maswali", "Jiandikishe"],
    helpTitle: "Msaada",
    helpLinks: ["Mwongozo wa Video", "Ripoti Hitilafu"],
    paymentTitle: "Malipo",
    copyright: "\u00A9 2025 ALFEAN ENTERPRISES. Haki zote zimehifadhiwa."
  },
  navbar: {
    siteName: "ALFEAN ENTERPRISES",
    loginText: "Ingia",
    registerText: "Anza Bure",
    links: [
      { id: 'features', label: 'Vipengele' },
      { id: 'features-details', label: 'Vipengele Vyote' },
      { id: 'screenshots', label: 'Picha' },
      { id: 'how-it-works', label: 'Hatua' },
      { id: 'pricing', label: 'Bei' },
      { id: 'faq', label: 'Maswali' },
    ]
  }
};

async function getLandingContent() {
  const result = await pool.query(
    `SELECT value FROM system_settings WHERE key = 'landing_content'`
  );
  if (result.rows.length === 0) {
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('landing_content', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(DEFAULT_CONTENT)]
    );
    return DEFAULT_CONTENT;
  }
  const row = result.rows[0];
  const val = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  // Merge freshly added default sections (e.g. featureDetails) underneath the
  // saved content so existing deployments pick up new landing sections without
  // the admin having to re-save, while keeping every customised value intact.
  // The feature catalog always tracks the code defaults.
  return { ...DEFAULT_CONTENT, ...val, featureDetails: DEFAULT_CONTENT.featureDetails };
}

router.get('/', async (c) => {
  try {
    const content = await getLandingContent();
    return c.json({ success: true, data: content });
  } catch (error) {
    console.error('[Landing] GET error:', error);
    return c.json({ success: true, data: DEFAULT_CONTENT });
  }
});

router.put('/', authMiddleware, async (c: any) => {
  try {
    const userRole = c.get('userRole');
    if (userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }
    const body = await c.req.json();
    const merged = { ...DEFAULT_CONTENT, ...body };
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('landing_content', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(merged)]
    );
    return c.json({ success: true, data: merged });
  } catch (error: any) {
    console.error('[Landing] PUT error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

router.post('/upload/screenshot', authMiddleware, async (c: any) => {
  try {
    const userRole = c.get('userRole');
    if (userRole !== 'developer') {
      return c.json({ success: false, error: 'Unauthorized' }, 403);
    }
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return c.json({ success: false, error: 'No file provided' }, 400);
    }
    // Strict image-only extension (alphanumeric, short) + size cap. The random
    // UUID filename already prevents path traversal, this prevents abuse.
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'png';
    if (!['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
      return c.json({ success: false, error: 'Only image files are allowed (png, jpg, webp, gif)' }, 400);
    }
    if (file.size > 5 * 1024 * 1024) {
      return c.json({ success: false, error: 'File is too large (max 5 MB)' }, 400);
    }
    const filename = `${uuidv4()}.${ext}`;
    const uploadDir = join(process.cwd(), 'public', 'uploads', 'screenshots');
    await mkdir(uploadDir, { recursive: true });
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(join(uploadDir, filename), buffer);
    const url = `/uploads/screenshots/${filename}`;
    return c.json({ success: true, data: { url } });
  } catch (error: any) {
    console.error('[Landing] Upload error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default router;
