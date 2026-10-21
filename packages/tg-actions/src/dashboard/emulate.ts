import { toDateKey } from "tg-domain/date";
import { EMULATED_SOURCE, formatItemId } from "tg-domain/ids";
import { ScrapedItemSchema } from "tg-domain/item";
import { enqueue } from "tg-firebase/tasks";

/**
 * *Emulate*: one fake post, queued for analyze as scrape would queue it, so the
 * pipeline can be watched without a live source. It is published like any
 * post: with no `target`, to `DEFAULT_TG_CHANNEL`.
 */

/** Plausible, weighty posts: the model reads them as important news, so they pass analyze. */
export const EMULATED_POSTS = [
  "Пожар на складе в Бресте: из соседних домов эвакуировали 200 человек, МЧС тушит огонь на площади 2000 кв. м.",
  "На трассе М1 под Борисовом столкнулись три фуры; движение в сторону Минска перекрыто на несколько часов.",
  "Минздрав объявил эпидемию гриппа в Гомельской области: школы закрывают на карантин до конца недели.",
  "Литва закрыла два пункта пропуска на границе; очередь грузовиков выросла до 1500 машин.",
  "Национальный банк неожиданно повысил ставку рефинансирования до 11%; рубль за день подешевел на 3%.",
  "Бывшего директора Минского тракторного завода задержали по делу о взятках на 2 млн долларов.",
  "Ураганный ветер оставил без электричества 300 деревень в Витебской области, повреждены сотни крыш.",
  "Паводок в Полесье: в Пинском районе затоплены 40 домов, жителей двух деревень эвакуируют.",
] as const;

export async function emulateItem(now = Date.now()): Promise<{ id: string }> {
  const item = ScrapedItemSchema.parse({
    id: formatItemId(EMULATED_SOURCE, String(now)),
    body: EMULATED_POSTS[Math.floor(Math.random() * EMULATED_POSTS.length)],
    date: toDateKey(now),
    kind: "post",
  });
  await enqueue("analyze", item);
  return { id: item.id };
}
