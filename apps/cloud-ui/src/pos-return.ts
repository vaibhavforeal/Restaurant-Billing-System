export function posReturnRequested(href:string):boolean {return new URL(href).searchParams.get('pos')==='1';}
