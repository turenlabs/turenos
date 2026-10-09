/**
 * The desktop's mark (`packages/ui/src/assets/brand/turen-mark.png`) as pixel art, one letter per pixel in
 * `palette`, two pixels to a terminal row. Below 32 pixels the mark's steep angle reads as a bird's head, so the
 * small anvils keep its horn, face, stump and water at a gentler angle.
 */

/** The mark's own colors, sampled from it. */
export const palette: Record<string, string> = {
  W: "#f7f6f3", // cream: the face, the stump
  g: "#c9cfd6", // cream in shade
  l: "#9ab3cd", // light water
  s: "#6f95c8", // water
  m: "#4171a8", // deep water
  B: "#2665ac", // the mark's blue
  D: "#24558d", // blue in shade
  n: "#172a52", // navy line
  k: "#0c1214", // ink: the hardy hole, the throat
}

/** The 40-pixel anvil (20 rows), sampled from the mark and cleaned by hand: the welcome screen on tall terminals. */
export const xl = [
  "...............................WW....",
  ".............................WWWWWW..",
  "...........................WWWWkWWWW.",
  ".........................WWWWWWWWWln.",
  ".......................WWWWWWWWWlnBB.",
  ".....................WWWWWWWWWlnnBB..",
  "...................WWWWWWWWWWnnBB....",
  ".................WWWWWWWWWWnnBBB.....",
  "...............WWWWWWWWWWlnBBBB......",
  ".............WWWWWWWWWWlnnBBBB.......",
  "............nWWWWWWWWlnBBBBBB........",
  "............nnWWWWWWnnBBBBBB.........",
  "..........nWWWWnWWWnBBBBBBB..........",
  "..........nWWWWBnBBBBBBBBB...........",
  ".........BBBBnnBnBBBBBBBBB...........",
  "........BlWWWlnBnBBBBBBBB............",
  "......BlWWWWWBnBnBBBBBBBB............",
  "....BBWWWlBBBBnBnBBBBlBBB............",
  "..BlWWWlBBnkkknkkBBBllllB............",
  ".lllnnnnkkk..kkkkkBlBllWWl...........",
  "...nnnn....nkkkkkkklllBslWWl.........",
  ".........lnnkkkkkkkWWlBnklWWl........",
  "........lsmmBmmmmmmWWBBnkkkBls.......",
  "........lmlmmmmmmmBWlBBlWlkBWls......",
  "........lmllmsslmmBWllWWWWWWlll......",
  "........lmslmmsmmmmWWWWWWllllWl......",
  "........msssmmsmlmmBBWWllWWllWl......",
  "........mmsBsmsssmmmlllWWWWllWs......",
  "........smmssmllsmsWllWWWWWlllss.....",
  ".......slsmslmlWslslWlWWWWWlllssl....",
  "......sslsmmlmsllssWWlWWWWWlWss.l....",
  "...llBssllmBsBsmlmllllWWWWlllssss....",
  "....lmssssmBlmssWmllWlWWWWlBllsssssm.",
  "..lslBssssmmlmsllllBWlWWWWBlBsssssss.",
  "...slmsssssmlmssllslllWWWlBlBsssssl..",
  "....ssssssssllsslmmllllllBBllBlssslB.",
  "...lsssssmsmslsllslsllslssmssBl......",
  "........ssssslsllmWmslsllsssBBls.....",
  "...........mmlslsslmssslls...........",
  "...........mB...ssl.ss...............",
]

/** The 32-pixel anvil (16 rows), the same way: the welcome screen on most terminals, phones included. */
export const large = [
  ".........................WW...",
  ".......................WWWWWW.",
  ".....................WWWWkWWln",
  "...................WWWWWWWlnB.",
  ".................WWWWWWWlnBB..",
  "...............WWWWWWWWnnBB...",
  ".............WWWWWWWWnnBB.....",
  "...........WWWWWWWWlnBBB......",
  "..........nWWWWWWlnBBBB.......",
  ".........nWnWWWlnBBBBB........",
  "........nWWWnWnBBBBBBB........",
  ".......BBnnnBnBBBBBBB.........",
  "......BlWWWnBnBBBBBBB.........",
  "....BlWWWlBnBnBBBBBB..........",
  "..BlWWlBBnknnnBBBBlB..........",
  ".lllnnnkkkkkkkkBlllWl.........",
  "........mkkkkkkllsBllWl.......",
  ".......smkkkkkkWWlBkkWll......",
  "......smsmBmmmBWWBnlkkBll.....",
  "......smlsmssmBWllWWWWWll.....",
  "......smssssslmWWWWWlWllW.....",
  "......ssmmmlslllBWllWWlll.....",
  "......llmmsllsllWlWWWWlll.....",
  "......llmssllsllWWWWWWlsss....",
  ".....slsmsssslllWlWWWWllsss...",
  "...smslsmlssslllWlWWWlllssss..",
  "..llBllsmllmslsBWlWWWBlssssls.",
  "..llsslsmllsslsBllWWlBlssssls.",
  "...lsslssslsllssllllBBlslssl..",
  "......lssslsllmsslllsmssls....",
  ".......ssBssllssssssls...s....",
  ".........ss..llsss.s..........",
]

/**
 * The 18-pixel anvil (9 rows), drawn for its size at a lower angle and without the hole, which read as an eye:
 * New session on large terminals, and a short welcome screen.
 */
export const medium = [
  "...........WWWWWWWWD.",
  ".......WWWWWWWWWWWgBD",
  "....WWWWWWWWWWWgBBBBD",
  "..gWWWWWWWWgBBBBBBBBD",
  "WWWWWWgBBBBBBBBBBBBD.",
  ".lBBBDnBBBBBBBBBBBD..",
  "...nnn.DBBBBBBBBBD...",
  ".......DBBBBBBBBD....",
  "........DBBBBBBD.....",
  ".......DgggggggggD...",
  "......DBBBBBBBBBBBD..",
  ".......mlsWWWWWWgls..",
  "......lsmlsWWWWWWgsl.",
  ".....slsmlsWWWWWWgsl.",
  "....mslsmlsWWWWWWgsl.",
  "...lmslsmlslWWWWgslsl",
  "..llmslsmlslslslsslsl",
  "....s..l..s.l..s..l..",
]

/** The 8-pixel anvil (4 rows): the compact logo, and the welcome screen when nothing larger fits. */
export const small = [
  ".....WWWWD",
  "..WWWWWgBD",
  "WWWWgBBBBD",
  ".lBDnBBBD.",
  "....DBBD..",
  "..DBBBBBD.",
  ".lsmWWWWsl",
  "lslsmlslsl",
]
