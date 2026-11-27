"""Common English words (lower-case), for the automatic hub deny terms (`offload.derive_auto_terms`).

A capitalised word in the DENIED sections of the hub MASTER_IDENTITY that is also an ordinary
English word (say "Anchor" or "Orbit") is not matched in every line as a private name: lower-case
uses ("an anchor for roles.ts", "a fixed orbit") are ordinary words. Such a term only
matches in its capitalised form in mid-sentence (`privacy._term_hit`), the form a name takes.

Deliberately left out: given names and virtue names (grace, hope, mark, rose, ...) and words that
commonly name a neighbourhood or a place (junction, annex, village, harbour, ...). A private name
of that kind keeps matching in any case. No personal values live here.
"""

from __future__ import annotations

_WORDS = """
a able about above accept access account across act action active activity actual add address admin advance advice affect after again
against agent agree ahead aim air alarm alert align all allow almost alone along already also alter always amount analysis anchor and
angle animal animation annual another answer any anyone anything apart app appeal appear apply approach approve area argue argument arm
around arrange array arrive arrow article artist ask aspect asset assign assist assume attach attack attempt attend audio audit author
auto automatic available average avoid aware away axis back background backup bad badge balance ball band bank bar base basic basket batch
battery battle beam bear beat become bed before begin behind being belief bell below belt bench bend benefit best better between beyond
big bin bind bird bit black blade blank blend block blog blood blow blue board boat body bold bolt bond bone book boost boot border boss
both bottle bottom bound box brain branch brand brave bread break brick brief bright bring broad broker brush buck bucket budget buffer
build bulk bullet bunch bundle burn burst business busy button buy cable cache cake calculate call calm camera camp campaign can cancel
candle canvas cap capital capture car carbon card care career carry cart case cash cast catch category cause cell center central chain
chair challenge champion chance change channel chapter charge chart chat cheap check chief child chip choice choose chord circle claim
class classic clean clear click client climb clip clock clone close cloud club clue coach coal coat code coffee coin cold collect color
colour column combine come comfort command comment commit common community company compare compass complete complex component compose
compute concept concern condition conduct config confirm conflict connect console constant contact contain content context continue
contract control convert cook cool copy core corner correct cost cotton couch count counter country couple course court cover craft
crash crate create credit crew crisp critical crop crowd crown cube cup cure current cursor curve custom customer cut cycle daily damage
dark dash data date deal debug decide deck decode deep default define degree delay delete deliver demand demo deploy depth design desk
detail detect develop device dial diamond diary digital direct direction dirt disk display distance divide doc dock document domain
door dot double down draft drag drain draw dream dress drift drill drink drive driver drop drum dry dual due dump dust duty dynamic
eager early earn earth ease east easy echo edge edit editor effect effort egg element elite email embed emerge empty enable end energy
engine enter entire entry environment equal error escape essay estate event every evidence exact example exchange execute exit expand
expect expert export express extend extra eye fabric face fact factor factory fail fair fall false family fan far farm fast fault favor
feature fee feed feel fence fetch fiber field figure file fill film filter final finance find fine finger finish fire firm first fish
fit fix flag flame flash flat fleet flex flight flip float flood floor flow flower fluid flush fly focus fold folder follow font food
force form format fortune forum forward foundation frame free fresh friend front frost fruit fuel full fun function fund future gain
game gap garage gate gather gauge gear general generate giant gift give glass global glow goal gold good govern grab grade grain graph
grass gray great green grid grip ground group grow guard guess guest guide guild habit half hall halt hammer hand handle hang happy hard
harvest hash hat head health heap hear heart heat heavy height help hero hidden high hint history hit hold hole home honest hook horizon
host hot hour house hub huge human idea ideal identity idle image impact import improve inbox include index industry info inner input
insert inside insight install instance instant intake intent interface internal invite issue item job join joint journal judge jump
junior just keep kernel key kick kind kit kitchen knife knot know label lab lamp land lane language large laser last late launch
layer layout lead leaf leak lean learn leave left legal lens lesson letter level library license life lift light limit line link list
listen live load local lock log logic long loop loose loss lot loud love low luck lunch machine magic mail main major make manage
manual map margin market mask master match material matrix matter max meal measure media medium meet member memo memory menu merge
mesh message metal meter method middle mind mine minor minute mirror miss mission mix mobile mode model modern module moment money
monitor month mood motion motor mount mouse move movie much multi music mute name native nature near need nerd net network new news
next node noise normal north note notice null number object observe ocean offer office offline old online only open operate option
orbit order origin other outer output outside over owner pace pack package pad page paint pair palette panel paper parent parse part
partner party pass past patch path pattern pause pay peak pen people perfect perform period permit person phase phone photo phrase
pick piece pilot pin pipe pipeline pitch pixel place plain plan plane planet plant plate platform play player plot plug plus pocket
point policy polish pool pop port portal position post pot power practice preset press preview price primary prime print priority
private problem process produce product profile program progress project promise prompt proof property protect proto proxy public pull
pulse pump punch pure purpose push puzzle quality query quest queue quick quiet quote race rack radio rail random range rank rate raw
reach react read ready real reason rebuild recall receive record recover red reduce refer reflect refresh region register release
remote remove render repair repeat replace reply report request rescue research reserve reset resolve resource response rest result
retail retry return review reward rich ride right ring rise risk road robot rock role roll room root rope round route row rule run
rush safe sale salt sample sand save scale scan scene schema school science scope score screen script scroll seal search season seat
second secret section secure seed select self sell send senior sense sensor sequence series serve server service session set setting
setup shade shadow shape share sharp shelf shell shift ship shop short shot show side sight sign signal silent silver simple single
site size sketch skill skin slice slide slot slow small smart smoke snap social soft solar solid solution solve sort sound source south
space spark speak special speed spell spend sphere spin spirit split sport spot spring square stack staff stage stamp stand standard
start state static station status stay steady steam steel step stick still stock storage store story stream street stress strike
string strip strong structure studio study style subject submit success suite summary super supply support surface swap switch symbol
sync system table tag tail take talent talk tank tap target task taste tax team tech technical template tempo term test text theme
thing think thread ticket tide tight tile time timer tiny tip title today token tone tool top topic total touch tour tower town trace
track trade traffic trail train transfer trap travel tree trend trial trick trigger trip true trust truth try tube tune turn twin type
unit update upload upper urban usage use user valid value vault vector vendor venture version video view virtual vision visit visual
voice volume vote wait walk wall want warm warn wash watch water wave way weak wear web week weight well west wheel white whole wide
widget wild win window wire wise wish word work world worth write yard year yellow yield young zero zone
tech dev ops info demo promo intro admin auth sync async beta alpha meta pro max mini micro macro mega ultra hyper nano neo
"""

COMMON_WORDS = frozenset(_WORDS.split())

_SUFFIXES = ("ing", "ers", "ies", "ed", "er", "es", "ly", "s")


def is_common(word: str) -> bool:
    """True when `word` (any case) or a simple inflection of a listed word is a common English word."""
    w = (word or "").lower().strip("'’-")
    if not w:
        return False
    if w in COMMON_WORDS:
        return True
    for suf in _SUFFIXES:
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            stem = w[: -len(suf)]
            if stem in COMMON_WORDS or (suf == "ies" and stem + "y" in COMMON_WORDS) or (suf in ("ed", "er", "ers", "es", "ing") and stem + "e" in COMMON_WORDS):
                return True
    return False
