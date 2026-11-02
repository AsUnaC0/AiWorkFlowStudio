import { stripPersonaMarks } from './persona-format.util';

/**
 * 人格输出格式清洗单测。
 *
 * 这些标记来自早期的 QQ 机器人模板，平台完全不解析；
 * 清洗器是「Prompt 改完但历史还在污染」时的兜底，所以边界必须钉住：
 * 该删的删干净、不该动的（代码块、Markdown 表格）一个字符都别碰。
 */
describe('stripPersonaMarks', () => {
  it('把 ||| 还原成空行，并剥掉表情标签', () => {
    expect(
      stripPersonaMarks('白米饭啊|||热腾腾的那种 最香了 <sticker:开心>'),
    ).toBe('白米饭啊\n\n热腾腾的那种 最香了');
  });

  it('支持全角竖线与全角冒号', () => {
    expect(stripPersonaMarks('好啊｜｜｜走起<sticker：卖萌>')).toBe(
      '好啊\n\n走起',
    );
  });

  it('成对语音标签只去标签，保留里面的文字', () => {
    expect(stripPersonaMarks('<voice>我想你了</voice>')).toBe('我想你了');
  });

  it('代码块内的标签原样保留（用户可能就在问 XML）', () => {
    const input = '这样写：\n```xml\n<voice>hi</voice>\n```\n就这样';
    expect(stripPersonaMarks(input)).toBe(input);
  });

  it('Markdown 表格里的单竖线不动', () => {
    const input = '| 名称 | 值 |\n| --- | --- |\n| a | 1 |';
    expect(stripPersonaMarks(input)).toBe(input);
  });

  it('多余空行压成一个，且幂等', () => {
    const once = stripPersonaMarks('a|||b|||c');
    expect(once).toBe('a\n\nb\n\nc');
    expect(stripPersonaMarks(once)).toBe(once);
  });

  it('普通文本原样返回', () => {
    const input = '今天天气不错，出去走走吧。';
    expect(stripPersonaMarks(input)).toBe(input);
  });

  it('空字符串不炸', () => {
    expect(stripPersonaMarks('')).toBe('');
  });
});
