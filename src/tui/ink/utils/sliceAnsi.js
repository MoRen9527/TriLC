export default function sliceAnsi(text, begin, end) {
    if (text.length === 0)
        return '';
    if (begin <= 0)
        return text;
    return text.slice(begin, end);
}
