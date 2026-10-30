// Original Irodori CIE Lab/D65 creative operators. See the versioned processing record.
#ifndef IRODORI_CREATIVE_COLOR_H
#define IRODORI_CREATIVE_COLOR_H

#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include "creative-color-params.h"

#ifdef __FAST_MATH__
#error "Creative color agreement requires fast math to be disabled."
#endif

namespace irodori_creative_color {
using V = std::array<double, 3>;
using M = std::array<V, 3>;
using Pair = std::array<double, 2>;
using Range = std::array<double, 4>;

using Parameters = IrodoriCreativeColorParams;
static_assert(sizeof(Parameters) == 368, "Unexpected native creative-color ABI.");

// The wire packet uses 13 padded logical vectors, matching the GPU's unpaired values.
inline Parameters from_values(const std::array<double,52>& raw) {
    for (const double v:raw) if (!std::isfinite(v)) throw std::invalid_argument("Non-finite native color parameter.");
    if (std::abs(raw[0]) > 100. || std::abs(raw[1]) > 100.
        || std::floor(raw[0]) != raw[0] || std::floor(raw[1]) != raw[1]
        || (raw[2] != 0. && raw[2] != 1.) || (raw[3] != 0. && raw[3] != 1.)
        || raw[4] < .5 || raw[4] > 4. || std::abs(raw[5]) > 2.)
        throw std::invalid_argument("Invalid native color header.");
    for (const auto index:{6,7,43,47,51}) if (raw[index] != 0. || std::signbit(raw[index]))
        throw std::invalid_argument("Native color padding must be positive zero.");
    Parameters p{};
    p.saturation=raw[0];p.vibrance=raw[1];p.width=raw[4];p.balance=raw[5];
    p.mixer_active=static_cast<uint32_t>(raw[2]);p.grading_active=static_cast<uint32_t>(raw[3]);
    bool mixer_active=false, grading_active=false;
    for (std::size_t i=0;i<8;i++) {
        for (std::size_t c=0;c<4;c++) {
            const double v=raw[8+4*i+c];
            if ((c == 0 && (v < -.134 || v > 0.)) || (c == 1 && std::abs(v) > .5) || (c > 1 && std::abs(v) > 1.))
                throw std::invalid_argument("Invalid native color range.");
            p.ranges[i][c]=v;mixer_active=mixer_active || v != 0.;
        }
        const double real=1.+p.ranges[i][0], imaginary=p.ranges[i][1];
        if (std::abs(real*real+imaginary*imaginary-1.) > 1e-12)
            throw std::invalid_argument("Invalid native color rotation.");
    }
    for (std::size_t i=0;i<3;i++) {
        for (std::size_t c=0;c<3;c++) {
            const double v=raw[40+4*i+c];
            if (std::abs(v) > (c == 2 ? 1. : .5)) throw std::invalid_argument("Invalid native grading tone.");
            p.tones[i][c]=v;grading_active=grading_active || v != 0.;
        }
        if (std::hypot(p.tones[i][0],p.tones[i][1]) > .5+1e-12)
            throw std::invalid_argument("Invalid native grading strength.");
    }
    if (mixer_active != bool(p.mixer_active) || grading_active != bool(p.grading_active))
        throw std::invalid_argument("Native color activity does not match its parameters.");
    return p;
}

inline constexpr double epsilon = 216./24389., delta = 6./29.;
inline constexpr double slope = 24389./(27.*116.), inverse_slope = 116.*27./24389.;
inline constexpr double white_x = 3127./3290., white_z = 3583./3290.;
inline constexpr M srgb_to_xyz{{
    {506752./1228815.,87881./245763.,12673./70218.},
    {87098./409605.,175762./245763.,12673./175545.},
    {7918./409605.,87881./737289.,1001167./1053270.},
}};
inline constexpr M srgb_from_xyz{{
    {12831./3959.,-329./214.,-1974./3959.},
    {-851781./878810.,1648619./878810.,36519./878810.},
    {705./12673.,-2585./12673.,705./667.},
}};
inline constexpr M rec2020_to_xyz{{
    {63426534./99577255.,20160776./139408157.,47086771./278816314.},
    {26158966./99577255.,472592308./697040785.,8267143./139408157.},
    {0.,19567812./697040785.,295819943./278816314.},
}};
inline constexpr M rec2020_from_xyz{{
    {30757411./17917100.,-6372589./17917100.,-4539589./17917100.},
    {-19765991./29648200.,47925759./29648200.,467509./29648200.},
    {792561./44930125.,-1921689./44930125.,42328811./44930125.},
}};

inline double dot(const V& a, const V& b) {
    return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
}
inline V transform(const M& matrix, const V& value) {
    return {dot(matrix[0],value),dot(matrix[1],value),dot(matrix[2],value)};
}
inline double smooth(double x) {
    const double t = std::max(0., std::min(1., x));
    return t*t*(3.-2.*t);
}
inline double lab_f(double v) {
    return v > epsilon ? std::cbrt(v) : ((24389./27.)*v+16.)/116.;
}
inline double lightness(double y) {
    return y <= epsilon ? (24389./27.)*y : 116.*std::cbrt(y)-16.;
}
inline double difference(double x, double y) {
    if (x == y) return 0.;
    if (x <= epsilon && y <= epsilon) return (x-y)*slope;
    if (x > epsilon && y > epsilon) {
        const double a=std::cbrt(x), b=std::cbrt(y);
        return (x-y)/(a*a+a*b+b*b);
    }
    if (x > epsilon) {
        const double a=std::cbrt(x);
        return (x-epsilon)/(a*a+a*delta+delta*delta)+(epsilon-y)*slope;
    }
    return -difference(y,x);
}
inline double inverse_delta(double value, double change) {
    if (change == 0.) return 0.;
    const double next=value+change;
    if (value > delta && next > delta) return change*(next*next+next*value+value*value);
    if (value <= delta && next <= delta) return change*inverse_slope;
    if (value <= delta) return (delta-value)*inverse_slope+(next-delta)*(next*next+next*delta+delta*delta);
    return (delta-value)*(delta*delta+delta*value+value*value)+(next-delta)*inverse_slope;
}
inline double lightness_ratio(double y, double next, double gain) {
    if (gain == 1.) return 1.;
    if (y <= epsilon && next <= epsilon) return gain;
    return lightness(next)/lightness(y);
}
struct Lab { V xyz; V value; };
inline Lab lab(const V& rgb, const M& matrix) {
    if (rgb[0] == rgb[1] && rgb[1] == rgb[2]) return {{white_x*rgb[0],rgb[0],white_z*rgb[0]}, {rgb[0],0.,0.}};
    const V xyz=transform(matrix,rgb);
    return {xyz,{xyz[1],500.*difference(xyz[0]/white_x,xyz[1]),200.*difference(xyz[1],xyz[2]/white_z)}};
}
inline const std::array<Pair,8>& directions() {
    static const std::array<Pair,8> result=[] {
        constexpr std::array<V,8> encoded{{{1.,0.,0.},{1.,.5,0.},{1.,1.,0.},{0.,1.,0.},{0.,1.,1.},{0.,0.,1.},{.5,0.,1.},{1.,0.,1.}}};
        std::array<Pair,8> values{};
        for (std::size_t i=0;i<8;i++) {
            V rgb{};
            for (std::size_t c=0;c<3;c++) rgb[c]=encoded[i][c] <= .04045 ? encoded[i][c]/12.92 : std::pow((encoded[i][c]+.055)/1.055,2.4);
            const auto value=lab(rgb,srgb_to_xyz).value;
            const double length=std::hypot(value[1],value[2]);
            values[i]={value[1]/length,value[2]/length};
        }
        return values;
    }();
    return result;
}
struct Selection { std::size_t first=0, second=1; double blend=0., protection=0.; };
inline Selection selection(const V& rgb, const M& matrix) {
    if (rgb[0] == rgb[1] && rgb[1] == rgb[2]) return {};
    const double peak=std::max({std::abs(rgb[0]),std::abs(rgb[1]),std::abs(rgb[2])});
    if (peak == 0.) return {};
    const auto value=lab({rgb[0]/peak,rgb[1]/peak,rgb[2]/peak},matrix).value;
    const double l=lightness(value[0]), c2=value[1]*value[1]+value[2]*value[2], denominator=l*l+4.*c2;
    const double p=smooth(((denominator > 0. ? c2/denominator : 0.)-.0004)/.006);
    if (p == 0.) return {};
    const auto& anchors=directions();
    const auto cross=[&](const Pair& direction) {return direction[0]*value[2]-direction[1]*value[1];};
    const double first_cross=cross(anchors[0]);double left=first_cross;
    for (std::size_t i=0;i<8;i++) {
        const auto next=(i+1)%8;const double next_cross=next == 0 ? first_cross : cross(anchors[next]), right=-next_cross;
        if (left >= 0. && right >= 0. && left+right > 0.) return {i,next,smooth(left/(left+right)),p};
        left=next_cross;
    }
    throw std::runtime_error("The native color hue has no reference interval.");
}
inline V mixer(const V& value, const Selection& selected, const Parameters& p) {
    if (!p.mixer_active || selected.protection == 0.) return value;
    Range amounts{};
    for (std::size_t i=0;i<4;i++) amounts[i]=selected.protection*(p.ranges[selected.first][i]*(1.-selected.blend)+p.ranges[selected.second][i]*selected.blend);
    if (amounts == Range{}) return value;
    const double real=1.+amounts[0], imaginary=amounts[1], length=std::hypot(real,imaginary);
    const double cosine_delta=-imaginary*imaginary/(length*(real+length)), sine=imaginary/length;
    const double gain=amounts[3] == 0. ? 1. : std::pow(2.,amounts[3]), y=value[0]*gain;
    const double scale=(1.+amounts[2])*lightness_ratio(value[0],y,gain);
    return {y,(value[1]+cosine_delta*value[1]-sine*value[2])*scale,(value[2]+sine*value[1]+cosine_delta*value[2])*scale};
}
inline V grading_amounts(double y, const Parameters& p) {
    if (!p.grading_active) return {};
    V weights{1.,0.,0.};
    if (y > 0.) {
        const double z=std::log2(y/.18)+p.balance;
        const double left=smooth((z+2.+p.width)/(2.*p.width)), right=smooth((z-2.+p.width)/(2.*p.width));
        weights={1.-left,left-right,right};
    }
    V result{};
    for (std::size_t i=0;i<3;i++) for (std::size_t c=0;c<3;c++) result[c]+=weights[i]*p.tones[i][c];
    if (y <= 0.) result[0]=result[1]=0.;
    return result;
}
inline V intensity(const V& value, const Parameters& p) {
    if (p.saturation == 0. && p.vibrance == 0.) return value;
    if (p.saturation == -100.) return {value[0],0.,0.};
    const double l=lightness(value[0]), denominator=l*l+4.*(value[1]*value[1]+value[2]*value[2]);
    const double weight=denominator > 0. ? l*l/denominator : 0.;
    const double gain=(1.+p.saturation/100.)*std::pow(2.,p.vibrance/100.*weight);
    return {value[0],value[1]*gain,value[2]*gain};
}
inline V grading(const V& value, const V& amounts) {
    if (amounts == V{}) return value;
    const double gain=amounts[2] == 0. ? 1. : std::pow(2.,amounts[2]), y=value[0]*gain;
    const double ratio=lightness_ratio(value[0],y,gain), strength=std::max(0.,lightness(y));
    return {y,value[1]*ratio+strength*amounts[0],value[2]*ratio+strength*amounts[1]};
}
inline V result(const V& rgb, const Lab& original, const V& value, const M& inverse) {
    if (value == original.value) return rgb;
    if (value[1] == 0. && value[2] == 0.) return {value[0],value[0],value[0]};
    const double change_f=difference(value[0],original.xyz[1]);
    const V change{
        white_x*inverse_delta(lab_f(original.xyz[0]/white_x),change_f+(value[1]-original.value[1])/500.),
        value[0]-original.xyz[1],
        white_z*inverse_delta(lab_f(original.xyz[2]/white_z),change_f-(value[2]-original.value[2])/200.),
    };
    const V delta_rgb=transform(inverse,change);
    return {rgb[0]+delta_rgb[0],rgb[1]+delta_rgb[1],rgb[2]+delta_rgb[2]};
}

// The caller supplies its existing intensity operator to preserve old neutral pixels exactly.
template <typename ExistingIntensity>
inline V apply(const V& rgb, const Parameters& p, bool rec2020, ExistingIntensity existing) {
    if (!p.mixer_active && !p.grading_active) return existing(rgb);
    const M& matrix=rec2020 ? rec2020_to_xyz : srgb_to_xyz;
    const Lab original=lab(rgb,matrix);
    const V mixed=p.mixer_active ? mixer(original.value,selection(rgb,matrix),p) : original.value;
    const V amounts=grading_amounts(mixed[0],p);
    if (mixed == original.value && amounts == V{}) return existing(rgb);
    return result(rgb,original,grading(intensity(mixed,p),amounts),rec2020 ? rec2020_from_xyz : srgb_from_xyz);
}
}
#endif
