export const READ_ONLY={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
export const OPEN_READ={readOnlyHint:true,destructiveHint:false,openWorldHint:true};
export const WRITE_LOCAL={readOnlyHint:false,destructiveHint:false,openWorldHint:false};
export const WRITE_EXTERNAL={readOnlyHint:false,destructiveHint:false,openWorldHint:true};
export function textResult(text,structuredContent={}){return{structuredContent,content:[{type:'text',text}]};}
export const normalizeBn=value=>String(value||'').toUpperCase().replace(/[\s-]/g,'');
