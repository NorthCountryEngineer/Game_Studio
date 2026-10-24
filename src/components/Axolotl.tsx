export function Axolotl({className='',dark=false}:{className?:string;dark?:boolean}){
  return <svg className={className} viewBox="0 0 700 470" role="img" aria-label="Illustration of a smiling pink axolotl swimming among water plants">
    <defs><pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.3" fill="#173d38" opacity=".09"/></pattern></defs>
    <ellipse cx="367" cy="270" rx="278" ry="170" fill={dark?'#2d5e53':'#dce7ca'}/><ellipse cx="367" cy="270" rx="278" ry="170" fill="url(#dots)"/>
    <g fill="none" stroke="#7a9877" strokeWidth="9" strokeLinecap="round"><path d="M108 422q23-130-40-206m40 108q-43-51-66-57m73 100q42-67 42-113M598 414q-6-114 50-225m-43 137q41-41 73-43m-68 77q-50-71-39-120"/></g>
    <g fill="#aac29c"><ellipse cx="70" cy="220" rx="13" ry="32" transform="rotate(-35 70 220)"/><ellipse cx="150" cy="253" rx="13" ry="31" transform="rotate(25 150 253)"/><ellipse cx="649" cy="197" rx="13" ry="32" transform="rotate(30 649 197)"/></g>
    <path d="M402 250q125-122 189-49-48 6-60 80-23 119-179 71" fill="#e2a0ba" stroke="#173d38" strokeWidth="5"/><path d="M419 252q100-65 148-51" fill="none" stroke="#b66687" strokeWidth="3"/>
    <path d="M283 277q91-77 162-3 23 45-13 91-49 61-162-5" fill="#f7ccdb" stroke="#173d38" strokeWidth="5"/>
    <g fill="#f7ccdb" stroke="#173d38" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"><path d="M335 342q-10 40-41 46l-18-7 10-10m111-37q18 33 44 33l17-14-14 1M276 294q-22 26-38 32l-23-11 17-3"/></g>
    <g fill="none" stroke="#bd6685" strokeWidth="13" strokeLinecap="round"><path d="M247 238q-57-49-81-90m80 109q-82-6-110-23m108 41q-58 27-79 65m183-101q59-46 79-91m-76 111q72-7 105-26m-106 44q65 37 77 61"/></g>
    <g stroke="#bd6685" strokeWidth="6" strokeLinecap="round"><path d="m168 149-21-3m27 14 4-24m-30 102-15-16m26 20-8 17m19 68-22 1m28-15 11 16m231-176 20-3m-25 16-5-21m39 98 14-17m-31 21 12 15m-39 71 20 1m-26-15-11 19"/></g>
    <ellipse cx="293" cy="269" rx="86" ry="64" fill="#f7ccdb" stroke="#173d38" strokeWidth="5"/>
    <ellipse cx="245" cy="291" rx="14" ry="8" fill="#ec9fb8"/><ellipse cx="335" cy="291" rx="14" ry="8" fill="#ec9fb8"/>
    <circle cx="253" cy="262" r="8" fill="#173d38"/><circle cx="329" cy="262" r="8" fill="#173d38"/><circle cx="255" cy="259" r="2.5" fill="white"/><circle cx="331" cy="259" r="2.5" fill="white"/>
    <path d="M276 283q17 20 33-1" fill="none" stroke="#173d38" strokeWidth="4" strokeLinecap="round"/>
    <g fill="none" stroke="#7e9d8c" strokeWidth="2"><circle cx="531" cy="125" r="13"/><circle cx="501" cy="93" r="7"/><circle cx="542" cy="66" r="5"/><circle cx="188" cy="392" r="6"/></g>
    <path d="m543 379 4-13 5 13 14 5-14 4-5 13-4-13-13-4Z" fill="#dca34a"/><path d="m116 147 3-9 3 9 10 3-10 3-3 9-3-9-9-3Z" fill="#dca34a"/>
  </svg>;
}
