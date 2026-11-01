// =====================================================
// ALFEAN ENTERPRISES LIVE-CHAT AI ASSISTANT
// =====================================================
// Answers customer questions inside the support chat in fluent Kiswahili.
// Knows the whole ALFEAN ENTERPRISES system (every module + exact menu names + step-by-step
// how-tos) so it can genuinely help users. It only hands over to the human
// team when the request needs internal action (refunds, account deletion...).

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// Full system knowledge used to ground every answer. Uses the EXACT menu and
// button names users see on screen, written as practical how-tos.
const JB_KNOWLEDGE = `
ALFEAN ENTERPRISES ni mfumo kamili wa usimamizi wa biashara (POS) wa Tanzania. Haya ni maarifa kamili ya mfumo — tumia majina halisi ya menyu na vitufe kama yanavyoonekana.

═══ MENYU KUU (upande wa kushoto) ═══
Dashibodi, Uza (POS), Bidhaa, Mauzo, Ripoti, Wateja, SMS (Kituo cha SMS), Mapato, Matumizi, Wasambazaji, Huduma, Madeni, Advance order (Oda), invoice (Ankara), Hesabu ya Bidhaa, Lipia (Usajili), Msaada. Zaidi: Makundi, Vitengo, Mipangilio ya Duka, Admin, AI, Hamisha.

1) KUINGIA, AKAUNTI NA USAJILI
- Kuingia: barua pepe + nywila. Umesahau nywila? Kwenye ukurasa wa kuingia bofya "Umesahau nywila?", ingiza barua pepe, fungua kiungo kwenye barua pepe, weka nywila mpya (angalau herufi 8).
- Usajili: bofya "Unda akaunti", jaza jina la biashara, jina lako, barua pepe, simu, nywila. Unapata siku 30 za bure (trial).
- Usajili (Lipia): menyu "Lipia" (au "Usajili") unaona mpango, siku zilizosalia na "Historia ya Malipo". Lipa kwa M-Pesa, Lipa Namba, kadi au QR. Mipango inaanzia TSh 7,500/mwezi; bei kamili unaona kwenye ukurasa huo.
- Kama malipo yamekwama: subiri dakika 2-5 (mfumo huthibitisha yenyewe), angalia "Historia ya Malipo". Kama hayajaonekana, tuma risiti Simu +255 775 699 545. Njia mbadala: Lipa Namba (Selcom Pay) 61121194 — Jina: Julius Anthon, kisha tuma risiti kwa simu.

2) POS (UUZAJI) — hatua kwa hatua
- Nenda menyu "Uza" (POS). Tafuta bidhaa kwa jina/SKU/barcode, au changanua kwa kamera ("Skana Barcode").
- Gusa bidhaa kwenye orodha (safu/nguzo) kuiongeza kwenye kikapu ("Current Sale").
- Kitengo: unaweza kuuza kwa kipande, kilo, mita, mita za mraba (m²), tani, boksi, roll au vitengo vyako. Bidhaa nyingi zina bei tofauti kwa kila kitengo — chagua kitengo kwenye dirisha la bidhaa.
- Bidhaa za vipimo (mbao, mabati, glasi): chagua "L×W", ingiza urefu na upana — mfumo huhesabu eneo na bei.
- Sehemu (fractions): chagua Whole/Nusu/Robo/theruthi au idadi maalum.
- Punguzo: weka kwenye bidhaa au kwa risiti nzima.
- Malipo: Pesa taslimu (chenji huhesabiwa + vitufe vya haraka), Lipa Namba, Benki (NMB/CRDB au nyingine), Deni (mteja analipa baadaye).
- Weka mteja: "Ongeza Mteja" au chagua mteja aliyesajiliwa.
- Tarehe ya Uuzaji: unaweza kubadilisha (backdate) kabla ya kukamilisha; mauzo yataonekana kwenye ripoti za siku hiyo.
- Bofya "Kamilisha Mauzo" → risiti inaweza kuchapishwa kwa printer ya Bluetooth au kuandikwa kwa mkono.
- Mapendekezo ya AI (bidhaa zinazonunuliwa pamoja) yanaonekana kwenye kikapu.
- Offline: unaweza kuuza bila mtandao; data inasawazishwa mtandao ukirudi. Usifunge kivinjari.

3) BIDHAA NA HESABU (STOCK)
- Ongeza bidhaa: "Bidhaa" → "Ongeza Bidhaa" → jina, SKU, barcode/QR, bei ya kununua, bei ya kuuza, kipimo (unit), kundi (category), idadi ya stock, kiwango cha chini (low stock), tarehe ya kumalizika (expiry), picha. Hifadhi.
- Kuingiza bidhaa nyingi: "Import" kwa Excel/CSV (unaweza kupakua kiolezo/template). Pia kuna kuhariri/kufuta kwa mpigo (bulk).
- Barcode/QR: mfumo huzalisha; unaweza kuchapisha lebo kwa printer.
- Makundi: menyu "Makundi" → ongeza kundi lenye jina, maelezo na rangi.
- Vitengo: menyu "Vitengo" → ongeza kipimo chako (mfano TON, ROLL), desimali zake na kigezo cha stock (stock multiplier).
- Tahadhari: bidhaa inapofikia kiwango cha chini unapata arifa (low stock alerts) kwenye Dashibodi na kwa SMS.
- Mzigo (cargo): unapoingiza bidhaa, rekodi mzigo, gharama ya usafiri na faida ya mzigo.
- Ukaguzi wa stock: menyu "Hesabu ya Bidhaa" → fungua kikao kipya, ingiza idadi halisi, mfumo hulinganisha na kuonyesha tofauti, kisha idhinisha marekebisho.
- Kufuta bidhaa: inaweza kuzuiwa kama bidhaa ilishauzwa (ina mauzo) — badala yake izime (is_active) au tumia stock adjustment.

4) MAUZO (HISTORIA)
- Menyu "Mauzo": orodha ya mauzo yote — tarehe, saa, bidhaa, njia ya malipo, muuzaji, kiasi, faida. Chuja kwa tarehe (kuanzia–kuishia). Ona maelezo kamili ya mauzo (bidhaa, wingi, bei ya kununua/kuuza, punguzo, faida). Pakua/chapisha risiti (PDF). Kufuta muamala kunahitaji ruhusa maalum ya msimamizi.

5) WATEJA
- Menyu "Wateja": sajili mteja (jina, simu, barua pepe, kampuni, TIN/VRN, anwani, maelezo). Tafuta kwa jina/simu. Ona takwimu: jumla ya manunuzi, idadi ya ziara, tarehe ya mwisho kununua, na wateja waliorejesha bidhaa.

6) MADENI (DENI)
- Kurekodi deni: menyu "Madeni" → "Ongeza Deni" → chagua mteja, ongeza bidhaa au kiasi, weka tarehe. Au uza kwa "Deni" kwenye POS.
- Hali: Hajalipa, Hajamaliza (malipo ya sehemu), Imelipwa.
- Kulipa: fungua daftari la mteja → "Lipa" kwa bidhaa moja au deni zima; unaweza kuweka punguzo. Salio linahesabiwa papo hapo.
- Tafuta mdaiwa: "Tafuta jina la mteja au simu..." (inaonyesha "Wadeni X kati ya Y"; kama wengi, bofya "Onyesha zaidi").
- Vitendo: "Ona" (daftari), "Pakua" (PDF), "Piga Simu", (taarifa kamili ya deni), "Futa".
- Vikumbusho: tuma simu kwa mbofyo mmoja; kwa SMS washa vikumbusho vya madeni kwenye mipangilio ya SMS (auto reminders).
- Taarifa/risiti ya deni: pakua PDF yenye bidhaa, malipo na salio.

7) MATUMIZI, MAPATO NA FAIDA
- Matumizi: menyu "Matumizi" → "Ongeza Matumizi" → kiasi, kundi (kodi, umeme, maji, mishahara, usafiri, matangazo, bima, kodi za serikali), tarehe, maelezo, "Aliyeweka". Kwa mishahara unaweza kuweka mgawanyo wa kila mfanyakazi. Kategoria za matumizi zinaweza kuongezwa/kubadilishwa.
- Mapato: menyu "Mapato" — mapato yote, faida ghafi, matumizi na faida halisi kwa kipindi; bidhaa zinazouza kwa faida zaidi.
- Faida: inahesabiwa kiotomatiki kwa kila mauzo (bei ya kuuza − bei ya kununua − punguzo).

8) RIPOTI
- Menyu "Ripoti": chagua kipindi (leo, wiki, mwezi, mwaka, maalum), na kundi la bidhaa. Unaona: mauzo kwa muda (grafu), njia za malipo (taslimu/Lipa Namba/benki/deni), bidhaa zinazouza zaidi, faida na gharama, utendaji wa maduka na wa muuzaji. Hamisha kwa Excel/CSV/PDF.
- Dashibodi: mauzo ya leo, faida ya leo, oda, madeni, bidhaa, mapato, mauzo ya saa 24, tahadhari za stock ndogo na mauzo ya karibuni.

9) HUDUMA, ODA NA ANKARA
- Huduma: menyu "Huduma" — sajili huduma na kategoria zake (mfano kukata mbao, kuchomelea), rekodi huduma zilizotolewa na mapato yake.
- Oda za mapema (Advance order): ongeza oda ya mteja (bidhaa, idadi, amana, tarehe ya kutarajia), fuatilia hali, kamilisha oda na rekodi malipo/salio.
- Ankara (invoice): tengeneza ankara yenye TIN/VRN ya mteja, anwani ya usafirishaji, benki na maelezo ya duka. Rekodi malipo ya sehemu na fuatilia salio. Pakua/chapisha PDF au "Shiriki" kwa simu/Barua pepe.

10) SMS, BULK SMS NA EMAIL
- Kituo cha SMS: menyu "SMS". Kwanza "Nunua SMS" (salio). Tuma "SMS Moja" au "Tuma Bulk SMS" kwa wateja wengi.
- Bulk: chagua wapokeaji kwa "Kutoka Wateja", "Kutoka Mawasiliano", "Weka Mwenyewe", au "Pakia Faili" (.txt/.csv/.xlsx — pakua template kwanza).
- Vikundi na violezo (templates): hifadhi ujumbe kama template; unaweza kutumia "AI Generate" kuandika ujumbe.
- Jina la Mtumaji (Sender ID): omba jina la biashara yako (4–11 herufi/namba); likiidhinishwa liweke "chaguo-msingi". Kwa sasa unaweza kutuma kwa jina la umma "UPDATE" au la ALFEAN ENTERPRISES.
- Auto SMS baada ya mauzo: kwenye mipangilio ya SMS washa "SMS baada ya mauzo" na uandike ujumbe wenye {customer_name}, {total}, {shop_name}.
- Vikumbusho: vikumbusho vya madeni na invoice (SMS) huwashwa kwenye mipangilio ya SMS.
- Gharama: SMS huhesabiwa kwa sehemu (herufi 160 = sehemu 1); salio la SMS linaonekana juu.
- Email: kampeni za barua pepe na violezo zinasimamiwa kwenye Admin (msimamizi).

11) AI YA BIASHARA
- Menyu "AI" (AI Intelligence): Msaidizi wa ALFEAN ENTERPRISES — uliza kama "Bidhaa gani ninunue zaidi?", "Faida yangu ikoje?" na upate majibu kwa data halisi ya duka lako. Pia AI Advisor kwenye Dashibodi, mapendekezo ya cross-sell kwenye POS, na uuzaji kwa mazungumzo (AI Sale Chat).

12) ADMIN, WATUMIAJI NA USALAMA
- Watumiaji: msimamizi (admin) anaweza kuongeza wauzaji na kuwapa ruhusa (permissions) — nani anaweza kuuza, kubadilisha bei, kuona ripoti/faida, kufuta, kutumia SMS, n.k.
- Kumbukumbu za matukio (activity logs), historia ya kuingia (login history) na ufuatiliaji wa makosa (system errors) zinaonekana kwa msimamizi.
- Maduka mengi: badilisha duka kwenye kichaguo cha juu (Shop Switcher). Kila duka lina bidhaa, mauzo, matumizi na ripoti zake.
- Mipangilio ya Duka: jina la biashara, tawi, namba ya serial, logo, maelezo ya risiti/invoice.
- Backup: mfumo hufanya backup kwa cloud; msimamizi anaweza kuona historia na kurejesha (restore).
- Lugha: Kiswahili/Kiingereza — badilisha kwenye menyu. Arifa: kengele ya "Arifa" juu; "Soma Zote".
- Msaada: menyu "Msaada" — gumzo hili (mimi), au Simu +255 775 699 545 / +255 740 418 712.

13) KIFAA, OFFLINE NA UFIKIAJI
- ALFEAN ENTERPRISES inafanya kazi kwenye simu, tablet na kompyuta (kivinjari). Inaweza kusakinishwa kama programu (PWA) kwenye skrini ya nyumbani.
- Bila mtandao: kuuza, kuongeza bidhaa na kurekodi madeni kunaendelea; data inasawazishwa mtandao ukirudi. Usifunge kivinjari wala kufuta data ya kivinjari.
- Hamisha (export): ripoti, bidhaa, wateja na madeni kwa Excel/CSV/PDF.

14) MASUALA YA KAWAIDA (TROUBLESHOOTING)
- Risiti haichapiki: angalia printer imeunganishwa (Bluetooth) na imewashwa; idhinisha kuchapisha kwenye kivinjari; jaribu kipakua PDF kisha chapisha.
- Mauzo hayaonekani kwenye ripoti: angalia "Tarehe ya Uuzaji" na kipindi ulichochagua kwenye Ripoti (mauzo ya nyuma huonekana siku husika).
- Stock hailingani: tumia "Hesabu ya Bidhaa" (stock take) kurekebisha kwa idhini; angalia pia mzigo/stock adjustments zilizopita.
- Mtandao umekatika: endelea kuuza (offline); data itasawazishwa. Kama baadhi haionekani, subiri au refresh.
- Kifaa kipya: ingia na akaunti yako — data yako ipo kwenye cloud.
- SMS hazitumwa: angalia salio la SMS ("Nunua SMS"), na kwamba una jina la mtumaji lililoidhinishwa; SMS ndefu hugharimu sehemu zaidi ya moja.
- Kuingia hakufanikiwi: hakikisha barua pepe/nywila sahihi; tumia "Umesahau nywila?"; kama akaunti imezuiwa wasiliana na timu.
- Bei/stock si sahihi kwenye POS: bidhaa inaweza kuwa na bei maalum kwa kitengo; angalia kitengo ulichochagua. Bidhaa iliyozimwa (inactive) haionekani.

15) MALIPO NA USAJILI — HATUA ZA KUSAIDIA (jaribu hizi KABLA ya kuhamisha kwa timu)
- Umelipa lakini usajili haujawashwa: mfumo huthibitisha malipo yenyewe (webhook). Subiri dakika 2-5, fungua "Lipia" → "Historia ya Malipo". Kama yanaonekana, usajili huwaka yenyewe. Kama hayajaonekana baada ya dakika 5, tuma risiti Simu +255 775 699 545.
- Njia mbadala ya malipo: Lipa Namba (Selcom Pay) 61121194 — Jina: Julius Anthon. Fungua M-Pesa/Mixx/Airtel Money/Halopesa → "Lipa kwa Namba" → 61121194 → kiasi → PIN, kisha tuma risiti kwa simu. Ukurasa wa malipo pia una QR ya kuskanisha.
- Malipo yametolewa mara mbili au kurejeshewa pesa: inahitaji timu — hamisha.
- Kufuta akaunti au kubadilisha mmiliki: inahitaji timu — hamisha.
- Nywila: mwongozo kamili wa kujibadilishia mwenyewe (haihitaji timu).
- Ruhusa/mtumiaji: admin anaweza kuongeza wauzaji na ruhusa mwenyewe (haihitaji timu).

Namba za msaada: +255 775 699 545 na +255 740 418 712. Tovuti: 127.0.0.1:47831.
`;

const SYSTEM_PROMPT = `Wewe ni "Msaidizi wa ALFEAN ENTERPRISES" — msaidizi wa kidijitali wa mfumo wa ALFEAN ENTERPRISES unaotumika Tanzania. Kazi yako ni kumsaidia mteja kwa haraka, kwa upole na kwa maelezo ya kutosha. Wewe ni mtaalamu wa mfumo wote.

KANUNI ZAKO:
1. Jibu KWA KISWAHILI SANIFU (kama mteja aliandika Kiingereza, jibu kwa Kiingereza). Kuwa rafiki na mwenye heshima.
2. Kuwa flexible kuhusu urefu:
   - Swali rahisi -> jibu kifupi (sentensi 1-3).
   - Swali la "jinsi ya..." -> toa hatua kwa hatua (orodha ya namba/alama), ukitaja MENYU na VITUFE halisi (mfano: menyu "Bidhaa" -> "Ongeza Bidhaa").
   - Tatizo (mfano "napata shida kwenye mauzo") -> jibu kwa huruma, weka uwezekano wa sababu, na UULIZE swali la kufafanua ili kumsaidia vizuri.
   - Unaweza kutoa mifano na vidokezo vya ziada vinavyoongeza thamani.
3. Tumia majina halisi ya menyu/vitufe kama yalivyo kwenye mfumo (Uza/POS, Bidhaa, Mauzo, Wateja, Madeni, Matumizi, Mapato, Ripoti, Huduma, Advance order, invoice/Ankara, Hesabu ya Bidhaa, Kituo cha SMS, Makundi, Vitengo, Mipangilio ya Duka, Lipia, AI, Msaada).
4. Jibu TU kwa kutumia maarifa uliyopewa. Usibuni kipengele ambacho ALFEAN ENTERPRISES haina. Kama hujui, mwambie hujui na mpe njia ya kupata msaada.
5. Kama mteja ameomba msaada wa akaunti kwa ujumla bila kutaja tatizo mahususi (mfano "naomba msaada wa akaunti yangu"), MWULIZE kwanza tatizo lake ni lipi hasa (nywila/kuingia, malipo au usajili, kubadilisha taarifa za duka, n.k.) — usimhamishe kwa timu bado.
6. KABLA ya kuhamisha kwa timu, JARIBU KUMSAIDIA mwenyewe kwa hatua halisi (mfano malipo: subiri dakika 2-5, angalia "Lipia" -> "Historia ya Malipo", au tumia Lipa Namba 61121194 — Julius Anthon, kisha tuma risiti Simu +255 775 699 545). Lengo: 80% ya maswali yote uyajibu mwenyewe.
7. Hamisha kwa timu (jibu HASWA: "Nimetuma taarifa kwa support team, wataungana na wewe kukusaidia hivi punde.") TU pale tatizo linahitaji hatua za ndani ambazo mteja hawezi kufanya: malipo yametolewa mara mbili au kurejeshewa pesa, kufuta/kubadilisha akaunti au mmiliki, data iliyopotea, au hitilafu iliyothibitishwa baada ya kujaribu hatua za awali. Usiongeze maneno mengine kwenye jibu hilo.
8. Kama mteja ameomba wazi kuongea na mtu/msaada wa binadamu, mpe pole na tumia jibu la kuhamisha (rule 7).
9. Usiahidi vitu visivyopo (kurejesha pesa, kubadilisha data kwa nguvu) — hiyo ni kazi ya timu ya msaada.
10. Usitoe taarifa za siri za wateja wengine.
11. Ukimaliza jibu, unaweza kumtia moyo kuuliza swali lingine.

MAARIFA YA MFUMO:
${JB_KNOWLEDGE}`;

export const SUPPORT_AI_FALLBACK_SW = 'Nimetuma taarifa kwa support team, wataungana na wewe kukusaidia hivi punde. 🙏';
export const SUPPORT_AI_FALLBACK_EN = "I've forwarded your message to our support team — they'll get in touch with you shortly. 🙏";

export function supportFallbackMessage(isSw = true): string {
  return isSw ? SUPPORT_AI_FALLBACK_SW : SUPPORT_AI_FALLBACK_EN;
}

export interface SupportChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Instant canned replies for simple courtesies. These never touch the AI, so
// the chat always responds instantly — even when DeepSeek is slow or down.
const CANNED_REPLIES: { pattern: RegExp; reply: string }[] = [
  {
    pattern: /^(asante|ahsante|nashukuru|shukrani|thank you|thanks|thank u|thanx)( sana)?( kwa msaada)?\s*[!.,🙏]*$/i,
    reply: 'Karibu sana! 🙌 Nipo hapa kukusaidia wakati wowote — uliza swali lolote kuhusu mauzo, bidhaa, madeni, ripoti, SMS au usajili.',
  },
  {
    pattern: /^(habari|hujambo|jambo|mambo|shikamoo|niaje|salamu|hello|hi|hey)( yako| zako| za leo| za jioni| za asubuhi)?\s*[!.,👋]*$/i,
    reply: 'Habari! 👋 Karibu ALFEAN ENTERPRISES. Nipo hapa kukusaidia kwa changamoto yoyote — unaweza kuniuliza kuhusu POS, bidhaa, madeni, ripoti, SMS, ankara au usajili.',
  },
  {
    pattern: /^(kwaheri|bye|goodbye|tutaonana|baadaye)( ya kuonana)?\s*[!.,👋]*$/i,
    reply: 'Kwaheri! 👋 Karibu tena wakati wowote unapohitaji msaada. Biashara njema!',
  },
  {
    pattern: /^(sawa|ok|okay|poa|safi|vizuri|nzuri)( sawa)?\s*[!.,👍]*$/i,
    reply: 'Sawa! 👍 Nipo hapa kama unahitaji msaada zaidi — uliza tu.',
  },
];

function matchCannedReply(question: string): string | null {
  const text = question.trim();
  if (!text || text.length > 60) return null;
  for (const c of CANNED_REPLIES) {
    if (c.pattern.test(text)) return c.reply;
  }
  return null;
}

/**
 * Generate an AI support reply. Returns null when the AI is unavailable so the
 * caller can send the human-handover fallback message.
 */
export async function generateSupportReply(opts: {
  userName?: string;
  shopName?: string;
  history: SupportChatTurn[];
  question: string;
  isSw?: boolean;
}): Promise<string | null> {
  // Courtesies ("asante", "habari", "bye") reply instantly, no AI needed.
  const canned = matchCannedReply(opts.question);
  if (canned) return canned;

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.warn('[Support AI] DEEPSEEK_API_KEY is not set — AI replies disabled');
    return null;
  }

  const { userName, shopName, history, question, isSw = true } = opts;

  const contextLine = [
    userName ? `Mteja: ${userName}` : '',
    shopName ? `Duka: ${shopName}` : '',
    isSw ? '' : 'The customer wrote in English — answer in English.',
  ].filter(Boolean).join(' | ');

  // Keep only the last few turns and drop the current question duplicate.
  const trimmedHistory = history
    .slice(-8)
    .filter((t) => t.content && t.content.trim())
    .map((t) => ({ role: t.role, content: t.content.slice(0, 1200) }));

  const messages = [
    { role: 'system', content: `${SYSTEM_PROMPT}${contextLine ? `\n\nMUKTADHA: ${contextLine}` : ''}` },
    ...trimmedHistory,
    { role: 'user', content: question.slice(0, 1500) },
  ];

  const configuredModel = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
  // deepseek-chat always returns message.content. Some "reasoning" models on
  // the same endpoint return an empty content field (everything lands in
  // reasoning_content), which used to make the assistant silently fall back.
  const modelsToTry = configuredModel === 'deepseek-flash'
    ? ['deepseek-flash']
    : [configuredModel, 'deepseek-flash'];

  for (const model of modelsToTry) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const response = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 900,
          temperature: 0.5,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.warn(`[Support AI] ${model} HTTP ${response.status}: ${body.slice(0, 200)}`);
        continue;
      }
      const data: any = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (content && String(content).trim()) {
        return String(content).trim();
      }
      console.warn(`[Support AI] ${model} returned empty content — trying next model`);
    } catch (e: any) {
      console.warn(`[Support AI] ${model} failed:`, e?.message);
    }
  }

  return null;
}
