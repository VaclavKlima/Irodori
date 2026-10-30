// CC0-1.0. Bounded numerical probe for the actual native color header; no image I/O.
#include "../../native/irodori-cpu-render/creative-color.h"
#include <cstdint>
#include <cstring>
#include <iostream>
#include <vector>

namespace color = irodori_creative_color;
uint32_t integer() {
    unsigned char b[4];
    if (!std::cin.read(reinterpret_cast<char*>(b),4)) throw std::runtime_error("Truncated probe integer.");
    return uint32_t(b[0])|(uint32_t(b[1])<<8)|(uint32_t(b[2])<<16)|(uint32_t(b[3])<<24);
}
double number() {
    const uint64_t lo=integer(), hi=integer(), bits=lo|(hi<<32);
    double value;std::memcpy(&value,&bits,8);
    if (!std::isfinite(value)) throw std::runtime_error("Non-finite probe input.");
    return value;
}
void write(double value) {
    if (!std::isfinite(value)) throw std::runtime_error("Non-finite probe result.");
    uint64_t bits;std::memcpy(&bits,&value,8);
    for (unsigned i=0;i<8;i++) std::cout.put(static_cast<char>((bits>>(8*i))&255));
}
color::V existing(const color::V& rgb, const color::Parameters& p, bool rec2020) {
    if ((p.saturation == 0. && p.vibrance == 0.) || (rgb[0] == rgb[1] && rgb[1] == rgb[2])) return rgb;
    const auto xyz=color::transform(rec2020 ? color::rec2020_to_xyz : color::srgb_to_xyz,rgb);
    if (p.saturation == -100.) return {xyz[1],xyz[1],xyz[1]};
    const double f=color::lab_f(xyz[1]), l=116.*f-16.;
    const double a=500.*(color::lab_f(xyz[0]/color::white_x)-f), b=200.*(f-color::lab_f(xyz[2]/color::white_z));
    const double denominator=l*l+4.*(a*a+b*b), weight=denominator > 0. ? l*l/denominator : 0.;
    const double gain=(1.+p.saturation/100.)*std::pow(2.,p.vibrance/100.*weight);
    const auto inverse=[](double v) {return v > color::delta ? v*v*v : (116.*v-16.)*(27./24389.);};
    return color::transform(rec2020 ? color::rec2020_from_xyz : color::srgb_from_xyz,
        {color::white_x*inverse(f+gain*a/500.),xyz[1],color::white_z*inverse(f-gain*b/200.)});
}
int main(int argc, char**) {
    try {
        char magic[8];
        if (argc != 1 || !std::cin.read(magic,8) || std::memcmp(magic,"IRODCLR1",8)) throw std::runtime_error("Invalid probe contract.");
        const auto count=integer(), cases=integer();
        if (!count || count > 128 || !cases || cases > 100000) throw std::runtime_error("Invalid probe bounds.");
        std::vector<color::Parameters> parameters(count);
        for (auto& p:parameters) {
            std::array<double,52> raw{};for (auto& v:raw) v=number();
            p=color::from_values(raw);
        }
        for (uint32_t i=0;i<cases;i++) {
            const auto setting=integer(), primary=integer();
            if (setting >= count || primary > 1) throw std::runtime_error("Invalid probe case identity.");
            const color::V rgb{number(),number(),number()};const auto& p=parameters[setting];const bool rec2020=primary == 1;
            const auto output=color::apply(rgb,p,rec2020,[&](const auto& value) {return existing(value,p,rec2020);});
            const auto selected=color::selection(rgb,rec2020 ? color::rec2020_to_xyz : color::srgb_to_xyz);
            for (const auto v:output) write(v);
            write(selected.first);write(selected.second);write(selected.blend);write(selected.protection);
        }
        if (std::cin.peek() != EOF || !std::cout.flush()) throw std::runtime_error("Probe framing failed.");
        return 0;
    } catch (const std::exception& e) {std::cerr<<e.what()<<'\n';return 1;}
}
