// Transformers.js 3.x defaults to English when language is omitted. Supply a
// decoder prefix ourselves and restrict the first decoding step to language tokens.
// The same encoder run and decoder cache are then used for transcription.
export function createLanguageProcessor(model, BaseProcessor) {
  const config = model.generation_config;
  const languages = Object.entries(config?.lang_to_id || {}).filter(([, id]) => Number.isInteger(id));
  const task = config?.task_to_id?.transcribe;
  const noTimestamps = config?.no_timestamps_token_id;
  const start = config?.decoder_start_token_id ?? model.config?.decoder_start_token_id;
  if (!languages.length || !Number.isInteger(task) || !Number.isInteger(noTimestamps) || !Number.isInteger(start)) {
    throw new Error('当前模型缺少多语言配置，请指定原语言或重新下载多语言 Whisper 模型');
  }
  const processor = new (class extends BaseProcessor {
    constructor() { super(); this.language = null; this.probability = 0; }
    _call(inputIds, scores) {
      const length = inputIds[0].length;
      const logits = scores.data;
      if (length === 1) {
        const values = languages.map(([token, id]) => ({ token, id, score: logits[id] }));
        const best = values.reduce((a, b) => b.score > a.score ? b : a);
        if (!Number.isFinite(best.score)) throw new Error('模型未返回有效语言概率');
        const sum = values.reduce((total, item) => total + Math.exp(item.score - best.score), 0);
        this.language = best.token.replace(/^<\||\|>$/g, '');
        this.probability = 1 / sum;
        logits.fill(-Infinity);
        for (const item of values) logits[item.id] = item.score;
      } else if (length === 2 || length === 3) {
        logits.fill(-Infinity);
        logits[length === 2 ? task : noTimestamps] = 0;
      }
      return scores;
    }
  })();
  return { processor, decoderInputIds: [[start]] };
}
