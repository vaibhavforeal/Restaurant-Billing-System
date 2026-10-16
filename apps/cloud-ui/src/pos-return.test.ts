import {expect,it} from 'vitest';
import {posReturnRequested} from './pos-return';
it('only returns to the same-origin POS for an explicit local handoff',()=>{
 expect(posReturnRequested('https://portal.test/owner/?pos=1')).toBe(true);
 expect(posReturnRequested('https://portal.test/owner/?returnTo=https://evil.test')).toBe(false);
 expect(posReturnRequested('https://portal.test/owner/')).toBe(false);
});
