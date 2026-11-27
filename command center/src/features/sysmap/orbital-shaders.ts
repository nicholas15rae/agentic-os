/**
 * Procedural GLSL for the Orbital Ecosystem: no textures at all (a few KB of shader code, so the
 * VRAM cost is the geometry plus one small glow sprite). 3D simplex noise by Ashima Arts / Stefan
 * Gustavson (MIT).
 */

export const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){
  float f=0.0;float a=0.5;
  for(int i=0;i<4;i++){f+=a*snoise(p);p*=2.03;a*=0.5;}
  return f;
}
`;

/** Shared vertex shader for lit bodies: world normal + world position. */
export const BODY_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
varying vec3 vObj;
void main(){
  vObj=position;
  vec4 w=modelMatrix*vec4(position,1.0);
  vW=w.xyz;
  vN=normalize(mat3(modelMatrix)*normal);
  gl_Position=projectionMatrix*viewMatrix*w;
}
`;

/**
 * Planet surface, physically flavoured: `uKind` 0 = gas giant (turbulent latitude bands, a great
 * storm, limb darkening), 1 = terrestrial (domain-warped continents, oceans with a sun glint,
 * relief from the height field, polar caps, drifting cloud deck, city lights on the night side
 * in the agent colour), 2 = ice world (cracked glaze, sub-surface tint). One star lights
 * everything from the origin: a hard terminator with a thin scattering band, a near-black night
 * side. uActive brightens and pulses; uDim greys a dormant / offline node; uAlert tints red.
 */
export const PLANET_FRAG = /* glsl */ `
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uAtmo;
uniform float uSeed; uniform float uTime; uniform float uActive; uniform float uDim; uniform float uAlert; uniform float uBands;
uniform float uKind;
varying vec3 vN; varying vec3 vW; varying vec3 vObj;
${NOISE}
float fbm6(vec3 p){
  float f=0.0;float a=0.5;
  for(int i=0;i<6;i++){f+=a*snoise(p);p*=2.02;a*=0.5;}
  return f;
}
void main(){
  vec3 p=normalize(vObj);
  vec3 N=normalize(vN);
  vec3 L=normalize(-vW);
  vec3 V=normalize(cameraPosition-vW);
  vec3 H=normalize(L+V);
  float ndl=dot(N,L);
  vec3 col;
  float spec=0.0;
  float clouds=0.0;
  float night=0.0;
  if(uKind<0.5){
    // Gas giant: latitude bands sheared by turbulence, fine streaks, one great storm.
    float turb=fbm(p*vec3(2.0,6.0,2.0)+uSeed+vec3(uTime*0.004,0.0,0.0));
    float lat=p.y+turb*0.09;
    float b=sin(lat*uBands*1.6+uSeed*3.0)*0.5+0.5;
    float b2=sin(lat*uBands*4.3+uSeed)*0.5+0.5;
    vec3 zone=mix(uC1,uC2,0.45);
    vec3 belt=mix(uC0,uC1,0.55);
    col=mix(belt,zone,smoothstep(0.25,0.75,b));
    col=mix(col,uC2,smoothstep(0.7,1.0,b2)*0.25);
    col=mix(col,uC0,smoothstep(0.92,1.0,b2)*0.3);
    float streak=fbm(vec3(p.x*3.0,lat*40.0,p.z*3.0)+uSeed);
    col*=0.94+streak*0.1;
    vec3 sc=normalize(vec3(cos(uSeed*2.0),-0.28,sin(uSeed*2.0)));
    float sd=length((p-sc)*vec3(1.0,2.1,1.0));
    float storm=smoothstep(0.32,0.0,sd);
    float swirl=fbm(p*14.0+vec3(sd*9.0));
    col=mix(col,mix(uC2,uC1,0.35)*(0.95+swirl*0.25),storm*0.85);
    col*=0.72+0.28*pow(max(dot(N,V),0.0),0.6);
  } else if(uKind<1.5){
    // Terrestrial: warped continents, coasts, mountains, ice caps, cloud deck.
    vec3 q=p*1.6+uSeed;
    vec3 w=vec3(fbm(q),fbm(q+5.2),fbm(q+9.7));
    float h=fbm6(p*1.7+w*0.8+uSeed);
    float sea=0.02;
    float land=smoothstep(sea,sea+0.03,h);
    float elev=clamp((h-sea)*2.4,0.0,1.0);
    vec3 deep=uC0*0.35;
    vec3 shallow=mix(uC0,uAtmo,0.35)*0.75;
    vec3 ocean=mix(deep,shallow,smoothstep(-0.25,sea,h));
    vec3 lowland=mix(uC1*0.85,uC1,fbm(p*9.0+uSeed)*0.5+0.5);
    vec3 high=mix(uC1*0.55,uC2*0.9,smoothstep(0.35,0.8,elev));
    vec3 ground=mix(lowland,high,smoothstep(0.15,0.7,elev));
    float cap=smoothstep(0.72,0.86,abs(p.y)+fbm(p*5.0)*0.08);
    col=mix(ocean,ground,land);
    col=mix(col,vec3(0.92,0.95,1.0),cap);
    // Relief read from the height field as soft shading (valleys darker, ridges catch light).
    col*=mix(1.0,0.78+0.32*elev,land*(1.0-cap));
    spec=pow(max(dot(normalize(vN),H),0.0),90.0)*(1.0-land)*(1.0-cap)*1.6;
    clouds=smoothstep(0.08,0.55,fbm6(p*3.1+vec3(uTime*0.012,0.0,uTime*0.007)+uSeed*1.3));
    night=smoothstep(0.55,0.85,fbm(p*42.0+uSeed))*land*(1.0-cap)*smoothstep(0.25,0.6,fbm(p*6.0+uSeed+3.0)*0.5+0.5);
  } else {
    // Ice world: pale glaze, blue crevasse network, sub-surface tint.
    float n=fbm6(p*3.0+uSeed);
    float cr=1.0-smoothstep(0.0,0.05,abs(fbm(p*7.0+uSeed*2.0)));
    col=mix(uC2,mix(uC1,vec3(0.85,0.92,1.0),0.5),smoothstep(-0.4,0.6,n));
    col=mix(col,uC0*0.7,cr*0.6);
    spec=pow(max(dot(normalize(vN),H),0.0),40.0)*0.5;
  }
  // One sun: hard terminator, a sliver of wrap, almost black night.
  float lit=smoothstep(-0.04,0.22,ndl);
  float cl=clamp(ndl,0.0,1.0);
  vec3 c=col*(0.015+1.15*(0.35*lit+0.65*cl));
  c=mix(c*(1.0-clouds*0.25),vec3(1.0)*(0.02+1.1*cl),clouds*0.85);
  c+=vec3(1.0,0.95,0.85)*spec*lit;
  float term=smoothstep(-0.1,0.05,ndl)*(1.0-smoothstep(0.05,0.3,ndl));
  c+=mix(vec3(1.0,0.45,0.2),uAtmo,0.5)*term*0.18;
  c+=uAtmo*night*(1.0-lit)*(0.9+uActive*0.8)*(1.0-clouds*0.7);
  float fres=pow(1.0-max(dot(normalize(vN),V),0.0),4.0);
  c+=uAtmo*fres*(0.08+0.7*smoothstep(-0.2,0.5,dot(normalize(vN),L)));
  c*=1.0+uActive*(0.22+0.1*sin(uTime*2.4));
  c=mix(c,vec3(dot(c,vec3(0.3,0.59,0.11)))*0.55,uDim);
  c=mix(c,vec3(1.0,0.25,0.25)*(0.3+lit),uAlert*0.6);
  gl_FragColor=vec4(c,1.0);
}
`;

/**
 * Atmosphere shell (additive): a thin Rayleigh-like halo, strongest on the sunlit limb and
 * reddening towards the terminator, gone on the night side.
 */
export const ATMO_FRAG = /* glsl */ `
uniform vec3 uAtmo; uniform float uStrength;
varying vec3 vN; varying vec3 vW; varying vec3 vObj;
void main(){
  vec3 V=normalize(cameraPosition-vW);
  vec3 N=normalize(vN);
  vec3 L=normalize(-vW);
  float f=pow(1.0-abs(dot(N,V)),4.5);
  float sun=dot(N,L);
  float lit=smoothstep(-0.35,0.45,sun);
  vec3 tint=mix(vec3(1.0,0.5,0.25),uAtmo,smoothstep(-0.1,0.4,sun));
  float a=f*lit*uStrength;
  gl_FragColor=vec4(tint*a*1.2,a);
}
`;

/**
 * Tony's star: convective granulation, sunspots with penumbra, faculae near the limb, and real
 * limb darkening (the disc dims and reddens towards its edge); hotter while Tony holds the token.
 */
export const STAR_FRAG = /* glsl */ `
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform float uTime; uniform float uActive; uniform float uDim;
varying vec3 vN; varying vec3 vW; varying vec3 vObj;
${NOISE}
void main(){
  vec3 p=normalize(vObj);
  vec3 V=normalize(cameraPosition-vW);
  float mu=max(dot(normalize(vN),V),0.0);
  float g1=snoise(p*28.0+vec3(uTime*0.12));
  float g2=snoise(p*55.0-vec3(uTime*0.18));
  float gran=smoothstep(-0.6,0.8,g1*0.7+g2*0.3);
  float big=fbm(p*3.5+vec3(0.0,uTime*0.03,uTime*0.02));
  vec3 c=mix(uC1,uC2,gran*0.75+big*0.25);
  float spots=fbm(p*5.0+vec3(7.3,uTime*0.01,1.1));
  float umbra=smoothstep(0.52,0.62,spots);
  float pen=smoothstep(0.4,0.52,spots);
  c=mix(c,uC0*0.55,pen*0.55);
  c=mix(c,uC0*0.18,umbra);
  float fac=smoothstep(0.35,0.6,fbm(p*9.0+3.0))*(1.0-mu)*0.6;
  c+=uC2*fac;
  float ld=0.4+0.6*mu;
  c*=ld;
  c=mix(c*vec3(1.0,0.78,0.55),c,mu);
  c*=1.55+uActive*0.45;
  c=mix(c,c*0.45,uDim);
  gl_FragColor=vec4(c,1.0);
}
`;

/** Backdrop: a tilted galactic band of violet and amber dust over deep obsidian. */
export const NEBULA_VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir=normalize(position);
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}
`;

export const NEBULA_FRAG = /* glsl */ `
varying vec3 vDir;
${NOISE}
void main(){
  vec3 d=normalize(vDir);
  vec3 axis=normalize(vec3(0.18,1.0,0.32));
  float band=1.0-smoothstep(0.0,0.42,abs(dot(d,axis)));
  float n=fbm(d*3.2);
  float m=fbm(d*7.0+n);
  vec3 violet=vec3(0.20,0.09,0.32);
  vec3 amber=vec3(0.42,0.20,0.06);
  vec3 c=vec3(0.006,0.008,0.016);
  c+=violet*band*smoothstep(-0.3,0.6,n)*0.55;
  c+=amber*band*band*smoothstep(0.1,0.8,m)*0.35;
  c+=vec3(0.02,0.05,0.07)*smoothstep(0.4,0.9,n)*0.4;
  gl_FragColor=vec4(c,1.0);
}
`;

/** Stars: size-attenuated soft points that twinkle a little (per-star phase). */
export const STARS_VERT = /* glsl */ `
attribute float aSize; attribute float aPhase; attribute vec3 aColor;
uniform float uTime; uniform float uPx;
varying vec3 vC; varying float vA;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.0);
  float tw=0.75+0.25*sin(uTime*1.3+aPhase);
  vC=aColor; vA=tw;
  gl_PointSize=aSize*uPx*(60.0/-mv.z)*tw;
  gl_Position=projectionMatrix*mv;
}
`;

export const STARS_FRAG = /* glsl */ `
varying vec3 vC; varying float vA;
void main(){
  vec2 q=gl_PointCoord-0.5;
  float d=length(q);
  float a=smoothstep(0.5,0.0,d);
  a*=a;
  gl_FragColor=vec4(vC*a*vA,a*vA);
}
`;

/** A hand-off arc: a bright head runs from source to target, a fading tail behind it. */
export const ARC_VERT = /* glsl */ `
attribute float aU;
varying float vU;
void main(){
  vU=aU;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}
`;

export const ARC_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uProg; uniform float uFade;
varying float vU;
void main(){
  float head=smoothstep(0.16,0.0,abs(vU-uProg));
  float tail=smoothstep(uProg-0.55,uProg,vU)*step(vU,uProg)*0.45;
  float base=0.10;
  float a=(head+tail+base)*uFade;
  gl_FragColor=vec4(uColor*(0.6+head*1.6),a);
}
`;

/** Finance's ring: banded translucent amethyst. */
export const RING_VERT = /* glsl */ `
varying float vR;
void main(){
  vR=length(position.xy);
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}
`;

export const RING_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uSealed; uniform float uIn; uniform float uOut;
varying float vR;
void main(){
  float r=clamp((vR-uIn)/(uOut-uIn),0.0,1.0);
  float bands=0.55+0.45*sin(r*48.0)*sin(r*13.0+1.3);
  float edge=smoothstep(0.0,0.08,r)*smoothstep(1.0,0.86,r);
  float a=bands*edge*(0.35+0.3*uSealed);
  gl_FragColor=vec4(uColor*(0.8+0.6*uSealed),a);
}
`;
